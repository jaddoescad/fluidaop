import { Page, expect, test } from '@playwright/test';

/** Open the Board's explicit Signal review surface. */
async function openSignal(page: Page) {
  await page.locator('.fl-sig').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

/** The Signal/Action popup stacked above the lead workspace. */
function popupAbove(page: Page) {
  return page.locator('.fc:not(.lw)');
}

const person = {
  id: '11111111-1111-4111-8111-111111111111',
  displayName: 'Chuck Furey',
  primaryEmail: 'chuck@example.com',
  primaryPhone: '+16135550123',
  entityType: 'person',
  roles: ['lead'],
  needsAttention: true,
  pendingRecommendationCount: 1,
  recentSignalCount: 4,
  latestActivityAt: '2026-08-25T14:30:00.000Z',
  urgency: 'Follow up',
};

const pipelineDeal = {
  id: '50768199720ced498fcf3040ff8ade',
  personId: person.id,
  personMatchCount: 1,
  customerName: person.displayName,
  email: person.primaryEmail,
  phone: person.primaryPhone,
  dealName: 'Exterior repaint',
  stage: 'Cold Leads',
  status: 'Open',
  label: '#1 Attempt',
  source: 'Meta Ads',
  amountCents: 0,
  lastChange: '2h',
  dealAge: '1d',
  salesperson: 'Scott Madden',
  capturedAt: '2026-08-26T14:00:50.852Z',
  receivedAt: '2026-08-19T14:00:00.000Z',
  stageEnteredAt: '2026-08-25T14:00:00.000Z',
  stageObservedAt: '2026-08-25T14:00:15.000Z',
  latestSignalAt: '2026-08-25T14:30:00.000Z',
  stageTouches: {
    outbound: 2,
    inbound: 1,
    automated: 1,
    lastAt: '2026-08-25T14:30:00.000Z',
    lastDirection: 'inbound',
    // The strip is anchored to the day the deal entered this stage, and this
    // one landed today — so it is a single lit cell, never padded out to a
    // fixed width.
    days: [3],
    daysBefore: 0,
  },
};

const pipelineHistory = {
  dealId: pipelineDeal.id,
  dealCreatedAt: '2026-08-19T14:00:00.000Z',
  dealCreatedEvidenceKind: 'inferred',
  dealCreatedLabel: 'Estimated from DripJobs deal age',
  dealCreatedMethod: 'sales_list_deal_age_d',
  dealCreatedConfidence: 0.6,
  currentStage: pipelineDeal.stage,
  stageEnteredAt: pipelineDeal.stageEnteredAt,
  items: [{
    id: 1,
    eventKind: 'baseline',
    fromStage: null,
    toStage: 'Warm Leads',
    effectiveAt: '2026-08-20T14:00:00.000Z',
    observedAt: '2026-08-20T14:00:00.000Z',
    source: 'baseline',
    evidenceKind: 'observed',
    durationSeconds: 432000,
    baseline: true,
  }, {
    id: 2,
    eventKind: 'stage_changed',
    fromStage: 'Warm Leads',
    toStage: 'Cold Leads',
    effectiveAt: pipelineDeal.stageEnteredAt,
    observedAt: pipelineDeal.stageObservedAt,
    source: 'zapier',
    evidenceKind: 'exact',
    durationSeconds: 131400,
    baseline: false,
  }],
  stages: [{
    stageEventId: 1,
    stage: 'Warm Leads',
    enteredAt: '2026-08-20T14:00:00.000Z',
    exitedAt: pipelineDeal.stageEnteredAt,
    durationSeconds: 432000,
    evidenceKind: 'observed',
    outcome: { kind: 'stage_changed', toStage: 'Cold Leads', at: pipelineDeal.stageEnteredAt },
    metrics: {
      total: 0, outboundCallAttempts: 0, connectedCalls: 0, missedInboundCalls: 0,
      inboundSms: 0, outboundSms: 0, inboundEmails: 0, outboundEmails: 0, milestones: 0,
    },
    touchpoints: [],
  }, {
    stageEventId: 2,
    stage: 'Cold Leads',
    enteredAt: pipelineDeal.stageEnteredAt,
    exitedAt: null,
    durationSeconds: 45000,
    evidenceKind: 'exact',
    outcome: { kind: 'current', toStage: null, at: null },
    metrics: {
      total: 1, outboundCallAttempts: 0, connectedCalls: 0, missedInboundCalls: 0,
      inboundSms: 1, outboundSms: 0, inboundEmails: 0, outboundEmails: 0, milestones: 0,
    },
    touchpoints: [{
      id: 'activity:49346',
      kind: 'activity',
      activityId: 49346,
      milestoneId: null,
      source: 'quo',
      eventType: 'message.received',
      channel: 'sms',
      direction: 'inbound',
      occurredAt: '2026-08-25T14:30:00.000Z',
      subject: 'Text message',
      preview: 'Can you send me the company website?',
      callStatus: null,
      durationSeconds: null,
      isAutomated: false,
      transcriptStatus: null,
      transcriptExcerpt: null,
      attributionMethod: 'unique_stage_window',
      evidenceKind: 'exact',
    }],
  }],
  unknownStage: {
    label: 'Before tracking / stage unknown',
    metrics: {
      total: 0, outboundCallAttempts: 0, connectedCalls: 0, missedInboundCalls: 0,
      inboundSms: 0, outboundSms: 0, inboundEmails: 0, outboundEmails: 0, milestones: 0,
    },
    touchpoints: [],
  },
  attribution: { attributedActivityCount: 1, manualActivityCount: 0, unassignedActivityCount: 0 },
  touchpointsTruncated: false,
  returnedTouchpointCount: 1,
};

const signal = {
  id: 49346,
  source: 'quo',
  eventType: 'message.received',
  direction: 'inbound',
  actorName: null,
  actorEmail: null,
  actorPhone: '+16135550123',
  subject: 'Text message',
  preview: 'Can you send me the company website?',
  occurredAt: '2026-08-25T14:30:00.000Z',
  contact: {
    id: person.id,
    displayName: person.displayName,
    primaryEmail: person.primaryEmail,
    primaryPhone: person.primaryPhone,
  },
  labels: [
    { kind: 'topic', name: 'Client Communication', color: '#43c78f' },
    { kind: 'urgency', name: 'Follow up', color: '#9d97f5' },
  ],
  attachmentCount: 0,
  review: { status: 'pending', resolution: null, pendingRecommendationCount: 1 },
};

const fluidSchedules = [
  {
    id: 'fluid-gmail-activities', runtimeName: 'fluid-gmail-activities', name: 'Gmail inbox sync', icon: '⚙️',
    description: 'Imports new Gmail messages into Fluid Signals.', schedule: 'Every 5 minutes', profile: 'Fluid server',
    mode: 'Script-only automation', runtimeMode: 'script', steps: [], enabled: true, state: 'Active',
    nextRunAt: '2026-08-26T02:35:00.000Z', lastRunAt: '2026-08-26T02:30:00.000Z', lastRunStatus: 'succeeded',
    lastError: null, historyAgentId: null, contractStatus: 'built-in', source: 'fluid', historyAvailable: false,
  },
  {
    id: 'fluid-gmail-label-sync', runtimeName: 'fluid-gmail-label-sync', name: 'Gmail label sync', icon: '⚙️',
    description: 'Applies Fluid labels to newly classified Gmail messages.', schedule: 'Every 30 seconds', profile: 'Fluid server',
    mode: 'Script-only automation', runtimeMode: 'script', steps: [], enabled: true, state: 'Active',
    nextRunAt: '2026-08-26T02:30:30.000Z', lastRunAt: '2026-08-26T02:30:00.000Z', lastRunStatus: 'completed',
    lastError: null, historyAgentId: null, contractStatus: 'built-in', source: 'fluid', historyAvailable: false,
  },
  {
    id: 'fluid-dripjobs-pipeline', runtimeName: 'fluid-dripjobs-pipeline', name: 'DripJobs pipeline audit', icon: '🔄',
    description: 'Repairs missed Zapier stage events from both DripJobs Sales List views.',
    schedule: 'Daily at 10:05 AM · America/Toronto', profile: 'Hermes capture',
    mode: 'Script-only automation', runtimeMode: 'script', steps: [], enabled: true, state: 'Active',
    nextRunAt: null, lastRunAt: pipelineDeal.capturedAt, lastRunStatus: 'succeeded',
    lastError: null, historyAgentId: null, contractStatus: 'built-in', source: 'fluid', historyAvailable: false,
  },
];

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-08-26T02:30:00.000Z'));
  let actionCreated = false;
  const action = {
    id: '33333333-3333-4333-8333-333333333333',
    actionDefinitionKey: 'draft-email-to-customer',
    actionDefinitionName: 'Draft email to customer',
    recommendationId: '22222222-2222-4222-8222-222222222222',
    sourceSignalId: String(signal.id),
    personId: person.id,
    contact: { id: person.id, displayName: person.displayName, primaryEmail: person.primaryEmail, primaryPhone: person.primaryPhone },
    caseId: null,
    status: 'awaiting_approval',
    executionMode: 'simulation',
    title: 'Draft an answer about the company website',
    reason: 'The customer asked for the company website and no later message answers the request.',
    recipient: person.primaryEmail,
    subject: 'Re: Text message',
    draftBody: 'Hi Chuck,\n\nOur website is https://paintersottawa.com. Let me know if you need anything else.',
    draftRevision: 1,
    lastError: null,
    simulatedAt: null,
    completedExternalAt: null,
    sourceSignal: {
      id: String(signal.id), subject: signal.subject, preview: signal.preview,
      bodyText: `${signal.preview}\n\nOn Monday, Ottawa Painters wrote:\n> Earlier thread content`,
      currentMessageText: signal.preview,
      rawBodyText: `${signal.preview}\n\nOn Monday, Ottawa Painters wrote:\n> Earlier thread content`,
      quotedText: 'On Monday, Ottawa Painters wrote:\n> Earlier thread content',
      hasQuotedContent: true,
      threadMessageCount: 6,
      occurredAt: signal.occurredAt, actorName: person.displayName, actorEmail: person.primaryEmail, threadId: 'thread-1',
    },
    createdAt: '2026-08-25T14:31:00.000Z',
    updatedAt: '2026-08-25T14:32:00.000Z',
  };
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/board/summary') return route.fulfill({ json: { signalsToday: 12, actionsOpen: 0, remindersDue: 0 } });
    if (path === '/api/labels') return route.fulfill({ json: { labels: [
      { kind: 'urgency', name: 'Urgent', color: '#f4587a', enabled: true },
      { kind: 'urgency', name: 'Follow up', color: '#9d97f5', enabled: true },
      { kind: 'urgency', name: 'Waiting on them', color: '#4cc4b8', enabled: true },
      { kind: 'urgency', name: 'Needs review', color: '#e07bb4', enabled: true },
      { kind: 'urgency', name: 'No action', color: '#8a8a96', enabled: true },
      { kind: 'topic', name: 'Client Communication', color: '#43c78f', enabled: true },
    ] } });
    if (path === '/api/board/people') return route.fulfill({ json: { items: [person], nextCursor: null, count: 1 } });
    if (path === '/api/board/pipeline' && url.searchParams.get('archived') === 'true') {
      return route.fulfill({ json: {
        count: 0,
        bucketCounts: {
          cold_lead: 0, estimate_scheduled: 0, proposal_sent: 0,
          closed_with_appointment: 0, closed_without_appointment: 0,
        },
        items: [],
        nextCursor: null,
      } });
    }
    if (path === '/api/board/pipeline') return route.fulfill({ json: {
      count: 1,
      capturedAt: pipelineDeal.capturedAt,
      sync: {
        cadence: 'daily',
        lastSucceededAt: pipelineDeal.capturedAt,
        status: 'healthy',
        stale: false,
        unhealthy: false,
      },
      items: [pipelineDeal],
    } });
    if (path === `/api/board/pipeline/${pipelineDeal.id}/history`) {
      return route.fulfill({ json: pipelineHistory });
    }
    if (path === '/api/board/signals') {
      const visibleSignal = actionCreated ? {
        ...signal,
        actionOpen: true,
        boardSortAt: '2026-08-26T02:29:30.000Z',
        review: { status: 'action_open', resolution: 'action_created', pendingRecommendationCount: 0 },
      } : signal;
      return route.fulfill({ json: { items: [visibleSignal], nextCursor: null } });
    }
    if (path === '/api/board/actions') {
      return route.fulfill({ json: { items: actionCreated ? [action] : [], nextCursor: null } });
    }
    if (path === '/api/board/reminders' || path === '/api/board/automations') {
      return route.fulfill({ json: { items: [], nextCursor: null } });
    }
    if (path === `/api/board/signals/${signal.id}` && route.request().method() === 'GET') {
      return route.fulfill({
        json: {
          signal,
          recommendations: [{
            id: '22222222-2222-4222-8222-222222222222',
            kind: 'action',
            label: 'Reply to the message',
            reason: 'The customer asked a direct question.',
            confidence: 0.95,
            capabilityKey: 'draft-email-to-customer',
            actionDefinitionKey: 'draft-email-to-customer',
            actionDefinitionVersion: 1,
            available: true,
            locked: false,
          }],
          history: [],
          historyNextCursor: null,
        },
      });
    }
    if (path === `/api/board/signals/${signal.id}/settle`) {
      return route.fulfill({ json: { activityId: signal.id, status: 'settled', resolution: 'no_action' } });
    }
    if (path === `/api/board/signals/${signal.id}/recommendations/22222222-2222-4222-8222-222222222222/accept`) {
      actionCreated = true;
      return route.fulfill({ json: { action: { id: action.id }, idempotent: false } });
    }
    if (path === `/api/board/actions/${action.id}` && route.request().method() === 'GET') {
      return route.fulfill({ json: { action, events: [{ id: 1, event_type: 'created', actor_type: 'user', actor_id: 'manager', metadata: {}, created_at: action.createdAt }] } });
    }
    if (path === '/api/hermes/status') {
      return route.fulfill({ json: { connected: true, version: 'test', gatewayState: 'running', activeAgents: 0, profiles: ['default'], checkedAt: new Date().toISOString() } });
    }
    if (path === '/api/hermes/schedules') return route.fulfill({ json: { agents: [], fetchedAt: new Date().toISOString() } });
    if (path === '/api/fluid/schedules') return route.fulfill({ json: { schedules: fluidSchedules, fetchedAt: new Date().toISOString() } });
    if (path === '/api/connections') return route.fulfill({ json: {
      connections: [{
        id: 'gmail-1', provider: 'gmail', email: 'info@paintersottawa.com', scopes: [], status: 'connected',
        createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-26T02:30:00.000Z',
        lastCheckedAt: '2026-08-26T02:30:00.000Z', lastHealthyAt: '2026-08-26T02:30:00.000Z',
        nextCheckAt: '2026-08-26T02:35:00.000Z', error: null, disconnectPending: false,
        health: {
          state: 'connected', lastEventAt: '2026-08-26T02:30:00.000Z', quietForMs: 0,
          toleranceMs: 900000, activeHours: true, reason: null,
        },
        permissions: { readEmails: true, applyLabels: true },
      }],
      healthCheckIntervalMs: 300000,
      gmail: { configured: true }, quo: { configured: true }, slack: { configured: true },
    } });
    if (path.startsWith('/api/board/')) return route.fulfill({ json: { items: [], nextCursor: null } });
    return route.fulfill({ status: 404, json: { error: 'Not mocked' } });
  });
});

test('keeps Signals first and shows the DripJobs sales stages', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('main.fl-cols > section')).toHaveCount(12);
  await expect(page.locator('main.fl-cols > section h2')).toHaveText([
    'Signals',
    'Cold Leads',
    'Warm Leads',
    'Estimate Requested',
    'Exterior Sales',
    'Estimate Scheduled',
    'In Draft',
    'Proposal(s) Sent',
    'On Hold · 0–1 mo',
    'On Hold · 1–6 mo',
    'Closed · With Appt.',
    'Closed · No Appt.',
  ]);
  await expect(page.locator('main.fl-cols > .fl-signals')).toHaveCount(1);
  await expect(page.locator('main.fl-cols > .fl-actions')).toHaveCount(0);
  await expect(page.locator('main.fl-cols > .fl-rems')).toHaveCount(0);
  await expect(page.locator('main.fl-cols > .fl-autos')).toHaveCount(0);
  await expect(page.locator('.fl-cols')).toHaveScreenshot('dripjobs-sales-pipeline.png', {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixels: 10,
  });
});

test('shows Quo recording, summary, next steps, and transcript on a call Signal', async ({ page }) => {
  const callSignal = {
    ...signal,
    eventType: 'call.completed',
    direction: 'outbound',
    subject: 'Outgoing call',
    preview: 'completed · 42 seconds',
  };
  await page.route('**/api/board/signals**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/board/signals') {
      return route.fulfill({ json: { items: [callSignal], nextCursor: null } });
    }
    if (path === `/api/board/signals/${callSignal.id}`) {
      return route.fulfill({ json: {
        signal: callSignal,
        recommendations: [],
        history: [],
        historyNextCursor: null,
        attachments: [],
        recordings: {
          status: 'available',
          items: [{
            id: 'CR_fixture',
            url: 'https://media.quo.com/recording.mp3',
            type: 'audio/mpeg',
            duration: 42,
            startTime: null,
            status: 'completed',
          }],
          unavailableReason: null,
          updatedAt: '2026-08-25T14:31:00.000Z',
        },
        callSummary: {
          status: 'available',
          summary: ['Customer requested an exterior estimate.'],
          nextSteps: ['Send the estimate by Friday.'],
          jobs: [],
          unavailableReason: null,
          updatedAt: '2026-08-25T14:31:00.000Z',
        },
        transcript: {
          status: 'available',
          text: 'Customer: Please send the estimate.\nTeam: We will send it Friday.',
          dialogue: [],
          updatedAt: '2026-08-25T14:31:00.000Z',
        },
      } });
    }
    return route.fallback();
  });

  await page.goto('/');
  await page.locator('.fl-sig').click();
  const selected = popupAbove(page).locator('.cv-turn.cv-marked');
  await expect(selected.getByText('Call recording', { exact: true })).toBeVisible();
  await expect(selected.locator('audio')).toHaveAttribute('src', 'https://media.quo.com/recording.mp3');
  await expect(selected.getByText('Customer requested an exterior estimate.', { exact: true })).toBeVisible();
  await expect(selected.getByText('Send the estimate by Friday.', { exact: true })).toBeVisible();
  await selected.getByText('Read full transcript', { exact: true }).click();
  await expect(selected.locator('.fd-sel-transcript pre')).toContainText('Please send the estimate.');
});

test('the board filter bar narrows the pipeline to one lead-received month', async ({ page }) => {
  const july = {
    ...pipelineDeal,
    id: 'july-deal',
    personId: person.id,
    customerName: 'Rita Vance',
    dealName: 'Deck stain',
    stage: 'Warm Leads',
    receivedAt: '2026-07-14T12:00:00.000Z',
  };
  const undated = {
    ...pipelineDeal,
    id: 'undated-deal',
    personId: person.id,
    customerName: 'Wes Tran',
    dealName: 'Garage doors',
    stage: 'Cold Leads',
    receivedAt: null,
  };
  await page.route('**/api/board/pipeline**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('archived') === 'true') return route.fallback();
    return route.fulfill({ json: {
      count: 3,
      capturedAt: pipelineDeal.capturedAt,
      sync: {
        cadence: 'daily',
        lastSucceededAt: pipelineDeal.capturedAt,
        status: 'healthy',
        stale: false,
        unhealthy: false,
      },
      items: [pipelineDeal, july, undated],
    } });
  });

  await page.goto('/');
  const select = page.locator('.pipeline-filter select');
  await expect(page.locator('.pipeline-card')).toHaveCount(3);
  await expect(select.locator('option')).toHaveText([
    'Any month', 'August 2026 (1)', 'July 2026 (1)',
  ]);
  // Deals with no received date are counted honestly rather than silently dropped.
  await expect(page.locator('.pipeline-filter-note')).toHaveText('1 undated');

  await select.selectOption('2026-07');
  await expect(page.locator('.pipeline-card')).toHaveCount(1);
  await expect(page.locator('.pipeline-card h3')).toHaveText('Rita Vance');
  await expect(page.locator('.pipeline-filter-count')).toHaveText('1 deal');

  await page.locator('.pipeline-filter-clear').click();
  await expect(page.locator('.pipeline-card')).toHaveCount(3);
  await expect(page.locator('.pipeline-filter-count')).toHaveCount(0);
});

test('keeps deal stages read-only and retains stage progress after reload', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('.pipeline-card');
  await expect(card).not.toHaveAttribute('draggable', 'true');
  await expect(card).not.toContainText('Open');
  await expect(card).not.toContainText('#1 Attempt');
  await expect(card).not.toContainText('In stage');
  await expect(card).not.toContainText('Changed');
  await expect(card).not.toContainText('Age');
  await expect(card.locator('.pipeline-source')).toHaveText('Meta Ads');
  // Only what happened in the stage the card sits in, and the automated send is
  // neither counted nor treated as the last touch.
  await expect(card.locator('.pipeline-touch-label')).toHaveText('2 touch points · 1 reply');
  await expect(card.locator('.pipeline-touch-when')).toHaveText('12h ago');
  await expect(card.locator('.pipeline-touches')).toHaveAttribute('data-heat', 'cool');
  // The strip starts the day the deal entered this stage, so a deal that
  // landed today is one lit cell rather than a padded-out fortnight.
  await expect(card.locator('.pipeline-day')).toHaveCount(1);
  await expect(card.locator('.pipeline-day')).toHaveClass(/is-l3/);
  await expect(card.locator('.pipeline-day-more')).toHaveCount(0);
  await expect(page.locator('.pipeline-filter-sync')).toHaveText(/Synced now/);
  await expect(page.locator('.pipeline-stage').first().locator('.pipeline-filter-bar')).toHaveCount(0);

  await card.click();
  await expect(page.locator('.fc.lw')).toBeVisible();
  await expect(page.locator('.lw-journey-tree')).toContainText('Lead received');
  await expect(page.locator('.lw-journey-tree')).toContainText('Appointment scheduled');
  await expect(page.locator('.lw-journey-tree')).toContainText('Proposal sent');
  await expect(page.locator('.lw-journey-tree')).toContainText('Deal closed');
  await expect(page.locator('.lw-stage-card')).toHaveCount(4);
  await expect(page.locator('.lw-stage-card').nth(0)).toContainText('Lead received');
  await expect(page.locator('.lw-stage-card').nth(1)).toContainText('Appointment scheduled · Not reached');
  await expect(page.locator('.lw-stage-card').nth(2)).toContainText('Proposal sent · Not reached');
  await expect(page.locator('.lw-stage-card').nth(3)).toContainText('Deal closed · Not reached');
  await expect(page.locator('.lw-journey-tree button')).toHaveCount(0);
  await expect(page.locator('.lw-chat-composer')).toBeVisible();
  await expect(page.locator('.lw-chat-stage-head')).toHaveCount(0);
  await page.locator('.fc.lw .fl-x').click();

  await page.reload();
  await page.locator('.pipeline-card').click();
  await expect(page.locator('.lw-stage-card').nth(0).locator('.lw-stage-divider')).toContainText('Lead received');
});

test('labels an unassociated Signal honestly instead of inventing an other Contact', async ({ page }) => {
  const unresolvedSignal = {
    ...signal,
    id: 49681,
    actorPhone: '+16136017855',
    contact: null,
    identityResolution: {
      status: 'unresolved',
      displayName: null,
      displayValue: '+16136017855',
      reason: 'No active Contact claims this exact identifier.',
    },
  };

  await page.route('**/api/board/signals**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/board/signals/${unresolvedSignal.id}`) {
      return route.fulfill({ json: {
        signal: unresolvedSignal,
        recommendations: [],
        history: [],
        historyNextCursor: null,
        attachments: [],
        transcript: null,
      } });
    }
    if (path === '/api/board/signals') {
      return route.fulfill({ json: { items: [unresolvedSignal], nextCursor: null } });
    }
    return route.fallback();
  });

  await page.goto('/');
  const card = page.locator('.fl-sig');
  await expect(card.locator('.role-unresolved')).toHaveText('unresolved contact');
  await expect(card).toContainText('+1 613 601 7855');

  await card.click();
  const header = page.locator('.fc:not(.lw) .fc-head-sub');
  await expect(header).toContainText('for +16136017855 · unresolved contact');
  await expect(header).not.toContainText('(other)');
});

test('caps the touch day strip at what a board column holds and marks the days it dropped', async ({ page }) => {
  // A deal parked far longer than the strip can draw: the oldest days fall off
  // the left, today stays the last cell, and the notch says days were dropped.
  const parked = {
    ...pipelineDeal,
    stageTouches: {
      ...pipelineDeal.stageTouches,
      days: [...Array<number>(21).fill(0).map((_, index) => (index === 20 ? 2 : 0))],
      daysBefore: 6,
    },
  };
  await page.route('**/api/board/pipeline**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('archived') === 'true') return route.fallback();
    return route.fulfill({ json: {
      count: 1,
      capturedAt: pipelineDeal.capturedAt,
      sync: {
        cadence: 'daily',
        lastSucceededAt: pipelineDeal.capturedAt,
        status: 'healthy',
        stale: false,
        unhealthy: false,
      },
      items: [parked],
    } });
  });

  await page.goto('/');
  const card = page.locator('.pipeline-card');
  await expect(card.locator('.pipeline-day')).toHaveCount(16);
  await expect(card.locator('.pipeline-day').last()).toHaveClass(/is-l2/);
  await expect(card.locator('.pipeline-day-more')).toHaveCount(1);
});

test('shows the pipeline latest signal when paginated People and Signals omit the contact', async ({ page }) => {
  await page.route('**/api/board/people**', (route) => route.fulfill({
    json: { items: [], nextCursor: null, count: 0 },
  }));
  await page.route('**/api/board/signals**', (route) => route.fulfill({
    json: { items: [], nextCursor: null },
  }));

  await page.goto('/');

  const card = page.locator('.pipeline-card');
  await expect(card.locator('.pipeline-touch-when')).toHaveText('12h ago');
  await card.click();
  await expect(page.locator('.fc.lw .lw-chat-titlebar')).toContainText('Last activity 12h ago');
});

test('scrolls every sales stage as one horizontal board', async ({ page }) => {
  await page.goto('/');
  const board = page.locator('.pipeline-cols');
  await expect(board).toHaveCSS('overflow-x', 'auto');
  await expect(page.locator('main.fl-cols > .pipeline-stage').first()).toHaveClass(/pipeline-stage/);
  const scroll = await board.evaluate((element) => {
    const before = element.scrollLeft;
    element.scrollLeft = 500;
    return { before, after: element.scrollLeft, width: element.scrollWidth, viewport: element.clientWidth };
  });
  expect(scroll.width).toBeGreaterThan(scroll.viewport);
  expect(scroll.after).toBeGreaterThan(scroll.before);
});

test('an enabled recommendation creates one Action only after the user clicks', async ({ page }) => {
  let settleRequests = 0;
  let acceptRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes(`/api/board/signals/${signal.id}/settle`)) settleRequests += 1;
    if (request.url().includes('/recommendations/22222222-2222-4222-8222-222222222222/accept')) acceptRequests += 1;
  });
  await page.goto('/');
  await openSignal(page);
  await expect(popupAbove(page).locator('.cv-marker')).toHaveText('this one');
  await expect(page.locator('.fc.lw')).toHaveCount(0);
  await expect(popupAbove(page).locator('.fd-sel-text').getByText('Can you send me the company website?', { exact: true })).toBeVisible();
  const recommendation = page.getByRole('button', { name: 'Reply to the message' });
  await expect(recommendation).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Mark settled' })).toBeEnabled();
  await expect.poll(() => settleRequests).toBe(0);
  await recommendation.click();
  await expect.poll(() => acceptRequests).toBe(1);
  await expect.poll(() => settleRequests).toBe(0);
  await expect(page.getByText('Action created. Hermes is drafting it now; review it in Actions.')).toBeVisible();
  await expect(page.getByText('A reply draft is ready in Actions.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open draft action' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark settled' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open draft action' }).click();
  await expect(page.getByRole('button', { name: 'Send (simulation)' })).toBeVisible();
  await page.locator('.la-popup').getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.fl-sig').first()).toContainText('Draft in Actions');
  await expect(page.locator('.pipeline-next-work').getByRole('button', { name: '✦ Draft an answer about the company website', exact: true })).toBeVisible();
});

test('makes a selected email and mixed-channel context glanceable', async ({ page }) => {
  const emailSignal = {
    ...signal,
    id: 49374,
    source: 'gmail',
    eventType: 'email.received',
    actorName: 'Chuck Furey',
    actorEmail: 'chuck@example.com',
    actorPhone: null,
    subject: 'Re: October start week',
    preview: 'Are we still on for the week of October 18?',
  };
  const emailBody = [
    'Hi Jad,',
    '',
    'Are we still on for the week of October 18?',
    '',
    'Thanks,',
    'Chuck',
    '',
    'On Tue, Aug 25, 2026 at 8:13 PM Ottawa Painters',
    '<info@paintersottawa.com> wrote:',
    '> The project is tentatively scheduled for October.',
  ].join('\n');
  const emailPipelineHistory = {
    ...pipelineHistory,
    stages: pipelineHistory.stages.map((stage, index) => index === 0 ? stage : {
      ...stage,
      metrics: {
        ...stage.metrics,
        inboundSms: 0,
        inboundEmails: 1,
      },
      touchpoints: [{
        id: `activity:${emailSignal.id}`,
        kind: 'activity',
        activityId: emailSignal.id,
        milestoneId: null,
        source: emailSignal.source,
        eventType: emailSignal.eventType,
        channel: 'email',
        direction: emailSignal.direction,
        occurredAt: emailSignal.occurredAt,
        subject: emailSignal.subject,
        preview: emailSignal.preview,
        callStatus: null,
        durationSeconds: null,
        isAutomated: false,
        transcriptStatus: null,
        transcriptExcerpt: null,
        attributionMethod: 'unique_stage_window',
        evidenceKind: 'exact',
      }],
    }),
  };

  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/board/pipeline/${pipelineDeal.id}/history`) {
      return route.fulfill({ json: emailPipelineHistory });
    }
    if (path === '/api/board/signals') {
      return route.fulfill({ json: { items: [emailSignal], nextCursor: null } });
    }
    if (path !== `/api/board/signals/${emailSignal.id}`) return route.fallback();
    return route.fulfill({ json: {
      signal: {
        ...emailSignal,
        bodyText: emailBody,
        currentMessageText: 'Hi Jad,\n\nAre we still on for the week of October 18?\n\nThanks,\nChuck',
        quotedText: 'On Tue, Aug 25, 2026 at 8:13 PM Ottawa Painters\n<info@paintersottawa.com> wrote:\n> The project is tentatively scheduled for October.',
        hasQuotedContent: true,
        threadMessageCount: 4,
      },
      recommendations: [{
        id: '88888888-8888-4888-8888-888888888888',
        kind: 'action',
        label: 'Draft an answer about the October start week',
        reason: 'The customer asked a current scheduling question that has not been answered.',
        confidence: 0.98,
        capabilityKey: 'draft-email-to-customer',
        actionDefinitionKey: 'draft-email-to-customer',
        actionDefinitionVersion: 1,
        available: true,
        locked: false,
      }],
      history: [{
        ...signal,
        id: 49370,
        source: 'quo',
        eventType: 'message.sent',
        direction: 'outbound',
        preview: 'I will confirm the schedule.',
        occurredAt: '2026-08-25T13:00:00.000Z',
      }, {
        ...signal,
        id: 49371,
        source: 'quo',
        eventType: 'call.completed',
        direction: 'inbound',
        preview: 'Incoming call',
        occurredAt: '2026-08-25T13:30:00.000Z',
      }, {
        ...emailSignal,
        id: 49372,
        direction: 'outbound',
        eventType: 'email.sent',
        preview: 'I am checking the calendar.',
        occurredAt: '2026-08-25T14:00:00.000Z',
      }],
      historyNextCursor: null,
      attachments: [{ attachmentKey: 'scope.pdf', filename: 'scope.pdf', mimeType: 'application/pdf', status: 'extracted', extractedText: 'Kitchen and hallway scope.' }],
      transcript: null,
    } });
  });

  await page.goto('/');
  await openSignal(page);

  const selected = popupAbove(page).locator('.cv-turn.cv-marked');
  await expect(selected.getByText('Re: October start week', { exact: true })).toBeVisible();
  await expect(selected.locator('.fd-sel-text-reply')).toContainText('Are we still on for the week of October 18?');
  await expect(selected.locator('.fd-sel-text-reply')).not.toContainText('On Tue, Aug 25');
  await expect(selected.locator('.src')).toHaveText('Email · Gmail');
  await expect(selected.locator('.src-direction-label')).toHaveText('Received');
  await expect(selected.getByText('Client Communication', { exact: true })).toBeVisible();
  await expect(selected.getByText('Follow up', { exact: true })).toBeVisible();
  await expect(selected.getByText('scope.pdf', { exact: true })).toBeVisible();

  const quoted = selected.locator('.fd-sel-text-quoted');
  await expect(quoted).not.toBeVisible();
  await expect(popupAbove(page)).toHaveScreenshot('signal-decision-glanceable.png', {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixels: 10,
  });
  await selected.getByText('Show quoted history', { exact: true }).click();
  await expect(quoted).toBeVisible();
  await expect(quoted).toContainText('The project is tentatively scheduled for October.');
  await expect(selected.getByText('Hide quoted history', { exact: true })).toBeVisible();

  const historySources = popupAbove(page).locator('.cv-turn:not(.cv-marked) .src');
  await expect(historySources).toHaveText(['SMS · Quo', 'Call · Quo', 'Email · Gmail']);
  await expect(popupAbove(page).locator('.cv-turn:not(.cv-marked) .src-direction-label')).toHaveText(['Sent', 'Received', 'Sent']);

  const decision = page.locator('.fd-dec');
  await expect(decision).toContainText('current scheduling question');
  await expect(decision.locator('.fd-dec-rec')).toHaveCount(0);
  await expect(page.getByText("✦ Hermes' read", { exact: true })).toHaveCount(0);
  await expect(page.getByText('Draft an answer about the October start week', { exact: true })).toHaveCount(1);
});

test('keeps the Signal decision anchored at the bottom while initial history loads above', async ({ page }) => {
  const initialHistory = Array.from({ length: 12 }, (_, index) => ({
    ...signal,
    id: 49500 + index,
    preview: `Initial history ${index + 1}`,
    occurredAt: new Date(Date.parse('2026-08-25T12:00:00.000Z') + index * 30_000).toISOString(),
  }));
  let releaseHistory!: () => void;
  const historyReleased = new Promise<void>((resolve) => { releaseHistory = resolve; });

  await page.route(`**/api/board/signals/${signal.id}?*`, async (route) => {
    await historyReleased;
    return route.fulfill({
      json: {
        signal,
        recommendations: [],
        history: initialHistory,
        historyNextCursor: null,
        attachments: [],
        transcript: null,
      },
    });
  });

  await page.goto('/');
  await openSignal(page);

  const body = popupAbove(page).locator('.fc-body');
  const selectedSignal = popupAbove(page).locator('.cv-turn.cv-marked');
  const decisionControls = popupAbove(page).locator('.fc-replies');
  await expect(selectedSignal).toBeVisible();
  const controlsBottomGapBefore = await body.evaluate((element) => {
    const controls = element.querySelector<HTMLElement>('.fc-replies');
    return controls ? element.getBoundingClientRect().bottom - controls.getBoundingClientRect().bottom : -1;
  });

  releaseHistory();
  await expect(page.getByText('Initial history 1', { exact: true })).toBeAttached();
  await expect(decisionControls).toBeVisible();
  const controlsBottomGapAfter = await body.evaluate((element) => {
    const controls = element.querySelector<HTMLElement>('.fc-replies');
    return controls ? element.getBoundingClientRect().bottom - controls.getBoundingClientRect().bottom : -1;
  });
  const historyComesFirst = await body.evaluate((element) => {
    const selected = element.querySelector<HTMLElement>('.cv-turn.cv-marked');
    const firstHistoryMessage = element.querySelector<HTMLElement>('[data-history-id]');
    return Boolean(
      selected &&
      firstHistoryMessage &&
      (firstHistoryMessage.compareDocumentPosition(selected) & Node.DOCUMENT_POSITION_FOLLOWING),
    );
  });
  const distanceFromBottom = await body.evaluate(
    (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
  );

  expect(Math.abs(controlsBottomGapAfter - controlsBottomGapBefore)).toBeLessThan(2);
  expect(Math.abs(distanceFromBottom)).toBeLessThan(2);
  expect(historyComesFirst).toBe(true);
});

test('loads earlier history above the timeline without jumping the current message', async ({ page }) => {
  const currentHistory = Array.from({ length: 12 }, (_, index) => ({
    ...signal,
    id: 49400 + index,
    preview: `Current history ${index + 1}`,
    occurredAt: new Date(Date.parse('2026-08-25T14:00:00.000Z') + index * 30_000).toISOString(),
  }));
  const earlierHistory = Array.from({ length: 8 }, (_, index) => ({
    ...signal,
    id: 49380 + index,
    preview: `Earlier history ${index + 1}`,
    occurredAt: new Date(Date.parse('2026-08-25T12:00:00.000Z') + index * 30_000).toISOString(),
  }));

  await page.route(`**/api/board/signals/${signal.id}?*`, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('historyCursor');
    return route.fulfill({
      json: {
        signal,
        recommendations: [],
        history: cursor === null ? currentHistory : earlierHistory,
        historyNextCursor: cursor === null ? 'earlier-page' : null,
        attachments: [],
        transcript: null,
      },
    });
  });

  await page.goto('/');
  await openSignal(page);

  const body = popupAbove(page).locator('.fc-body');
  const loadEarlier = page.getByRole('button', { name: 'Load earlier history' });
  const currentAnchor = page.getByText('Current history 1', { exact: true });
  await expect(loadEarlier).toBeAttached();
  await expect(currentAnchor).toBeAttached();

  const controlComesFirst = await body.evaluate((element) => {
    const control = element.querySelector<HTMLButtonElement>('button.fc-chip');
    const firstMessage = element.querySelector<HTMLElement>('.cv-turn[data-history-id]');
    return Boolean(
      control &&
      firstMessage &&
      (control.compareDocumentPosition(firstMessage) & Node.DOCUMENT_POSITION_FOLLOWING),
    );
  });
  expect(controlComesFirst).toBe(true);

  await loadEarlier.scrollIntoViewIfNeeded();
  const anchorTopBefore = await currentAnchor.evaluate((element) => element.getBoundingClientRect().top);
  await loadEarlier.click();
  await expect(page.getByText('Earlier history 1', { exact: true })).toBeAttached();
  await expect(loadEarlier).toHaveCount(0);
  const anchorTopAfter = await currentAnchor.evaluate((element) => element.getBoundingClientRect().top);

  expect(Math.abs(anchorTopAfter - anchorTopBefore)).toBeLessThan(2);
});

test('Send records a simulation without contacting Gmail or creating outbound Activity', async ({ page }) => {
  let simulated = false;
  let simulateRequests = 0;
  let providerWriteRequests = 0;

  await page.route('**/api/board/actions/33333333-3333-4333-8333-333333333333', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      json: {
        action: {
          id: '33333333-3333-4333-8333-333333333333',
          actionDefinitionKey: 'draft-email-to-customer',
          actionDefinitionName: 'Draft email to customer',
          recommendationId: '22222222-2222-4222-8222-222222222222',
          sourceSignalId: String(signal.id),
          personId: person.id,
          contact: { id: person.id, displayName: person.displayName, primaryEmail: person.primaryEmail, primaryPhone: person.primaryPhone },
          caseId: null,
          status: simulated ? 'simulated' : 'awaiting_approval',
          executionMode: 'simulation',
          title: 'Draft an answer about the company website',
          reason: 'The customer asked for the company website and no later message answers the request.',
          recipient: person.primaryEmail,
          subject: 'Re: Text message',
          draftBody: 'Hi Chuck,\n\nOur website is https://paintersottawa.com. Let me know if you need anything else.',
          draftRevision: 1,
          lastError: null,
          simulatedAt: simulated ? '2026-08-26T02:29:00.000Z' : null,
          completedExternalAt: null,
          sourceSignal: {
            id: String(signal.id), subject: signal.subject, preview: signal.preview,
            bodyText: `${signal.preview}\n\nOn Monday, Ottawa Painters wrote:\n> Earlier thread content`,
            currentMessageText: signal.preview,
            quotedText: 'On Monday, Ottawa Painters wrote:\n> Earlier thread content',
            hasQuotedContent: true,
            threadMessageCount: 6,
            occurredAt: signal.occurredAt, actorName: person.displayName, actorEmail: person.primaryEmail, threadId: 'thread-1',
          },
          createdAt: '2026-08-25T14:31:00.000Z',
          updatedAt: simulated ? '2026-08-26T02:29:00.000Z' : '2026-08-25T14:32:00.000Z',
        },
        events: simulated ? [
          { id: 1, event_type: 'created', actor_type: 'user', actor_id: 'manager', metadata: {}, created_at: '2026-08-25T14:31:00.000Z' },
          { id: 2, event_type: 'simulated_sent', actor_type: 'user', actor_id: 'manager', metadata: {}, created_at: '2026-08-26T02:29:00.000Z' },
        ] : [{ id: 1, event_type: 'created', actor_type: 'user', actor_id: 'manager', metadata: {}, created_at: '2026-08-25T14:31:00.000Z' }],
      },
    });
  });
  await page.route('**/api/board/actions/33333333-3333-4333-8333-333333333333/simulate-send', async (route) => {
    simulateRequests += 1;
    simulated = true;
    return route.fulfill({ json: { actionId: '33333333-3333-4333-8333-333333333333', status: 'simulated', idempotent: false } });
  });
  page.on('request', (request) => {
    const url = request.url();
    if (request.method() !== 'GET' && (/googleapis\.com|\/gmail\b|\/quo\b|\/api\/activities\b/i).test(url)) {
      providerWriteRequests += 1;
    }
  });

  await page.goto('/');
  await openSignal(page);
  await page.getByRole('button', { name: 'Reply to the message' }).click();
  await popupAbove(page).getByRole('button', { name: 'Close' }).click();
  await page.locator('.pipeline-next-work').getByRole('button', { name: '✦ Draft an answer about the company website', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send (simulation)' })).toBeVisible();
  await expect(page.locator('.la-source-meta .src')).toHaveText('Email · Gmail');
  await expect(page.locator('.la-source-meta .src-direction-label')).toHaveText('Received');
  await expect(page.getByText(`To ${person.primaryEmail}`, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View thread (6)' })).toBeVisible();
  await expect(page.getByText('Earlier thread content')).toHaveCount(0);
  await expect(page.getByText('Why this was suggested', { exact: true })).toBeVisible();
  await expect(page.getByText('The customer asked for the company website and no later message answers the request.', { exact: true })).not.toBeVisible();
  await expect(page.locator('.la-popup')).toHaveScreenshot('action-reply-composer.png', {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixels: 10,
  });
  await page.getByRole('button', { name: 'Send (simulation)' }).click();

  await expect.poll(() => simulateRequests).toBe(1);
  await expect(page.locator('.la-status')).toHaveText('Sent (simulation)');
  await expect(page.locator('.la-simulation strong')).toHaveText('Sent (simulation)');
  await expect(page.getByText(/No Gmail request was made, no outbound Activity was created/)).toBeVisible();
  expect(providerWriteRequests).toBe(0);
});

test('a pending Signal with no recommendation waits for a human decision', async ({ page }) => {
  let settleRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes(`/api/board/signals/${signal.id}/settle`)) settleRequests += 1;
  });
  await page.route(`**/api/board/signals/${signal.id}?*`, (route) => route.fulfill({
    json: {
      signal: { ...signal, review: { status: 'pending', resolution: null, pendingRecommendationCount: 0 } },
      recommendations: [],
      history: [],
      historyNextCursor: null,
      attachments: [],
      transcript: null,
    },
  }));

  await page.goto('/');
  await openSignal(page);
  await expect(page.getByText('Hermes has no suggested action. You still need to decide whether this Signal needs one.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark settled' })).toBeEnabled();
  await page.waitForTimeout(250);
  expect(settleRequests).toBe(0);
  await page.getByRole('button', { name: 'Mark settled' }).click();
  await expect.poll(() => settleRequests).toBe(1);
});

test('an outbound Signal also waits for manual settlement', async ({ page }) => {
  const outboundSignal = {
    ...signal,
    eventType: 'message.sent',
    direction: 'outbound',
    preview: 'Here is the company website: https://paintersottawa.com',
    review: { status: 'pending', resolution: null, pendingRecommendationCount: 0 },
  };

  await page.route('**/api/board/signals?*', (route) => route.fulfill({
    json: { items: [outboundSignal], nextCursor: null },
  }));
  await page.route(`**/api/board/signals/${signal.id}?*`, (route) => route.fulfill({
    json: {
      signal: outboundSignal,
      recommendations: [],
      history: [],
      historyNextCursor: null,
      attachments: [],
      transcript: null,
    },
  }));

  await page.goto('/');
  await openSignal(page);
  await expect(page.getByText('This was sent by your team. Review it, then manually settle this Signal.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark settled' })).toBeEnabled();
});

test('keeps live Actions and Reminders inside the relevant pipeline card', async ({ page }) => {
  await page.route('**/api/board/actions?*', (route) => route.fulfill({
    json: {
      items: [{
        id: '33333333-3333-4333-8333-333333333333',
        actionDefinitionKey: 'draft-email-to-customer',
        actionDefinitionName: 'Draft email to customer',
        recommendationId: '22222222-2222-4222-8222-222222222222',
        sourceSignalId: String(signal.id),
        personId: person.id,
        contact: { id: person.id, displayName: person.displayName, primaryEmail: person.primaryEmail, primaryPhone: person.primaryPhone },
        caseId: null,
        status: 'awaiting_approval',
        executionMode: 'simulation',
        title: 'Confirm the colour choice',
        reason: 'Created by the manager.',
        recipient: person.primaryEmail,
        subject: 'Re: Colour choice',
        draftBody: 'Hi Chuck, please confirm the colour choice.',
        draftRevision: 1,
        lastError: null,
        simulatedAt: null,
        completedExternalAt: null,
        sourceSignal: null,
        createdAt: '2026-08-25T14:20:00.000Z',
        updatedAt: '2026-08-25T14:20:00.000Z',
      }],
      nextCursor: null,
    },
  }));
  await page.route('**/api/board/reminders?*', (route) => route.fulfill({
    json: {
      items: [{
        id: '55555555-5555-4555-8555-555555555555',
        caseId: '44444444-4444-4444-8444-444444444444',
        contactId: person.id,
        jobName: 'Chuck Furey',
        actionKind: 'follow_up',
        title: 'Call tomorrow morning',
        reason: 'Created by the manager.',
        status: 'waiting',
        owner: null,
        dueAt: '2026-08-26T13:00:00.000Z',
        createdAt: '2026-08-25T14:25:00.000Z',
        updatedAt: '2026-08-25T14:25:00.000Z',
      }],
      nextCursor: null,
    },
  }));
  await page.goto('/');
  const nextWork = page.locator('.pipeline-next-work');
  await expect(nextWork.getByText('✦ Confirm the colour choice', { exact: true })).toBeVisible();
  await expect(nextWork).toContainText('Call tomorrow morning');
  await expect(page.locator('main.fl-cols > .fl-actions, main.fl-cols > .fl-rems, main.fl-cols > .fl-autos')).toHaveCount(0);
});

test('clicking a pipeline card opens the lead workspace and isolates their Signals', async ({ page }) => {
  await page.goto('/');

  await page.locator('.pipeline-card').click();

  // the workspace is anchored on the person, headed by the deal
  const workspace = page.locator('.fc.lw');
  await expect(workspace).toBeVisible();
  await expect(workspace.locator('.fc-head-main b')).toHaveText(person.displayName);
  await expect(workspace.locator('.fc-head-sub')).toContainText('Exterior repaint');
  await expect(workspace.locator('.fc-head-sub')).toContainText('Cold Leads');
  await expect(workspace.locator('.lw-contact')).toHaveText(`${person.primaryEmail}·${person.primaryPhone}`);
  await expect(workspace.locator(`a[href="mailto:${person.primaryEmail}"]`)).toBeVisible();
  await expect(workspace.locator(`a[href="tel:${person.primaryPhone}"]`)).toBeVisible();
  await expect(workspace.locator('.lw-journey-rail-head')).toContainText('Meta Ads');
  await expect(workspace.locator('.lw-chat-titlebar')).toContainText('Last activity 12h ago');
  // The left chat uses the four lifecycle milestones, independent of the
  // operational DripJobs board columns shown in the right journey tree.
  const stageCards = workspace.locator('.lw-stage-card');
  await expect(stageCards).toHaveCount(4);
  await expect(stageCards.nth(0)).toContainText('Lead received');
  await expect(stageCards.nth(0)).toContainText('SMS · Quo');
  await expect(stageCards.nth(1)).toContainText('Appointment scheduled · Not reached');
  await expect(stageCards.nth(2)).toContainText('Proposal sent · Not reached');
  await expect(stageCards.nth(3)).toContainText('Deal closed · Not reached');
  await expect(workspace.locator('.lw-chat-stage-head')).toHaveCount(0);
  await expect(workspace.locator('.lw-stage-channel-counts')).toHaveCount(0);
  await expect(workspace.locator('.lw-stage-outcome')).toHaveCount(0);
  await expect(workspace.locator('.lw-chat-composer textarea')).toHaveAttribute('placeholder', 'Ask Hermes about Chuck…');

  // the right rail summarizes the same journey without flattening its stages
  const journey = workspace.locator('.lw-journey-tree');
  await expect(journey.locator('li')).toHaveCount(4);
  await expect(journey.locator('button')).toHaveCount(0);
  await expect(journey.locator('li').nth(0)).toContainText('Lead received');
  await expect(journey.locator('li').nth(0)).toContainText('Now');
  await expect(journey.locator('li').nth(0).locator('.lw-tree-counts')).toHaveAttribute('aria-label', '0 calls, 1 texts, 0 emails');
  await expect(journey.locator('li').nth(1)).toContainText('Appointment scheduled');
  await expect(journey.locator('li').nth(1)).toContainText('Not reached');
  await expect(journey.locator('li').nth(2)).toContainText('Proposal sent');
  await expect(journey.locator('li').nth(3)).toContainText('Deal closed');

  // the cross-channel timeline shows their messages, flagged for decisions
  const message = workspace.locator('.cv-turn').filter({ hasText: 'Can you send me the company website?' });
  await expect(message).toContainText('Can you send me the company website?');
  // What the customer sent sits on its own side of the thread.
  await expect(message).toHaveClass(/cv-them/);
  await expect(message.locator('.lw-flag-open')).toHaveCount(0);
  await expect(stageCards.nth(0).locator('.cv-day')).toContainText('Today');
  await expect(message).not.toHaveAttribute('role', 'button');
  await expect(message).not.toHaveAttribute('tabindex');

  // The communication is the chat content itself; no Signal side-popup exists.
  await expect(page.locator('.fc-inspector')).toHaveCount(0);
  await expect(workspace.getByText('Hermes deal chat', { exact: true })).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(workspace).toBeHidden();
});

test('the deal workspace is an actual Hermes chat surface', async ({ page }) => {
  let requestBody: unknown = null;
  await page.route('**/api/hermes/deal-chat', async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({ json: { reply: 'Chuck has one text in Cold Leads and it still needs a decision.' } });
  });

  await page.goto('/');
  await page.locator('.pipeline-card').click();
  const workspace = page.locator('.fc.lw');
  const composer = workspace.locator('.lw-chat-composer textarea');
  await composer.fill('What happened in this stage?');
  await composer.press('Enter');

  await expect(workspace.locator('.lw-live-chat-turn.is-user')).toContainText('What happened in this stage?');
  await expect(workspace.locator('.lw-live-chat-turn.is-assistant')).toContainText('Chuck has one text in Cold Leads');
  expect(requestBody).toEqual({ dealId: pipelineDeal.id, message: 'What happened in this stage?' });
});

test('Action Library separates capabilities from Board instances', async ({ page }) => {
  await page.route('**/api/action-definitions', (route) => route.fulfill({
    json: {
      definitions: [{
        id: '66666666-6666-4666-8666-666666666666', key: 'draft-email-to-customer',
        name: 'Draft email to customer', description: 'Draft a reply for review.',
        handler: 'draft-email-reply', enabled: true, executionMode: 'simulation',
        requiresConfirmation: true, configuration: { tone: 'warm and concise' },
        version: 1, builtIn: true, executable: true, updatedAt: '2026-08-26T12:00:00.000Z',
      }, {
        id: '77777777-7777-4777-8777-777777777777', key: 'draft-sms-reply',
        name: 'Draft SMS reply', description: 'Coming later.', handler: 'draft-sms-reply',
        enabled: false, executionMode: 'simulation', requiresConfirmation: true,
        configuration: {}, version: 1, builtIn: true, executable: false,
        updatedAt: '2026-08-26T12:00:00.000Z',
      }],
    },
  }));
  await page.goto('/actions');
  await expect(page.getByRole('heading', { name: 'Actions', level: 1 })).toBeVisible();
  await expect(page.getByText('Simulation only', { exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Disable Draft email to customer' })).toBeEnabled();
  await expect(page.getByText('Draft SMS reply', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Insights' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Help & feedback' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Configure' }).click();
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  await page.getByLabel('Description').fill('Draft a warm reply for review.');
  await expect(save).toBeEnabled();
  await expect(page.locator('main.fl-cols')).toHaveCount(0);
});

test('loads Board and Hermes schedule data only on routes that need it', async ({ page }) => {
  let boardRequests = 0;
  let hermesScheduleRequests = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/board/')) boardRequests += 1;
    if (path === '/api/hermes/schedules') hermesScheduleRequests += 1;
  });

  await page.goto('/actions');
  await expect(page.getByRole('heading', { name: 'Actions', level: 1 })).toBeVisible();
  expect(boardRequests).toBe(0);
  expect(hermesScheduleRequests).toBe(0);

  await page.goto('/schedules');
  await expect(page.getByRole('heading', { name: 'Schedules', level: 1 })).toBeVisible();
  await expect.poll(() => hermesScheduleRequests).toBeGreaterThan(0);
  expect(boardRequests).toBe(0);

  await page.goto('/');
  await expect(page.locator('.pipeline-cols')).toBeVisible();
  await expect.poll(() => boardRequests).toBeGreaterThan(0);
});

test('waits for every initial Board loader before leaving the loading state', async ({ page }) => {
  let releasePipeline!: () => void;
  const pipelineReleased = new Promise<void>((resolve) => { releasePipeline = resolve; });
  await page.route('**/api/labels', (route) => route.fulfill({ status: 503, json: { error: 'Labels unavailable' } }));
  await page.route('**/api/board/pipeline', async (route) => {
    await pipelineReleased;
    return route.fulfill({ json: {
      count: 1,
      capturedAt: pipelineDeal.capturedAt,
      sync: { cadence: 'daily', lastSucceededAt: pipelineDeal.capturedAt, status: 'healthy', stale: false, unhealthy: false },
      items: [pipelineDeal],
    } });
  });

  await page.goto('/');
  await expect(page.getByText('Loading Board…', { exact: true })).toBeVisible();
  await page.waitForTimeout(150);
  await expect(page.getByText('Loading Board…', { exact: true })).toBeVisible();
  releasePipeline();
  await expect(page.getByText('Loading Board…', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Labels unavailable');
});

test('keeps Gmail permissions in Connections and recurring work in Schedules', async ({ page }) => {
  await page.goto('/connections');
  await expect(page.getByLabel('Gmail — info@paintersottawa.com')).toContainText('Read emails · Apply labels');
  await expect(page.getByText('Gmail label sync', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Fluid labels active', { exact: true })).toHaveCount(0);

  await page.goto('/schedules');
  await expect(page.getByText('Gmail inbox sync', { exact: true })).toBeVisible();
  await expect(page.getByText('Gmail label sync', { exact: true })).toBeVisible();
  await expect(page.getByText('DripJobs pipeline audit', { exact: true })).toBeVisible();
  await expect(page.getByText('Daily at 10:05 AM · America/Toronto', { exact: true })).toBeVisible();
  await expect(page.locator('.sc-badge-script')).toHaveCount(3);

  await page.goto('/agents');
  await expect(page.getByText('Gmail inbox sync', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Gmail label sync', { exact: true })).toHaveCount(0);
  await expect(page.getByText('DripJobs pipeline audit', { exact: true })).toHaveCount(0);
});

test('guards local-only cleanup after a provider disconnect remains pending', async ({ page }) => {
  let forcedDeleteRequests = 0;
  await page.route('**/api/connections', (route) => route.fulfill({ json: {
    connections: [{
      id: 'gmail-1', provider: 'gmail', email: 'info@paintersottawa.com', scopes: [], status: 'error',
      createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-26T02:30:00.000Z',
      lastCheckedAt: '2026-08-26T02:30:00.000Z', lastHealthyAt: '2026-08-26T02:25:00.000Z',
      nextCheckAt: null, error: 'Google token revocation failed.', disconnectPending: true,
      health: {
        state: 'attention', lastEventAt: '2026-08-26T02:25:00.000Z', quietForMs: 300000,
        toleranceMs: 900000, activeHours: true, reason: 'Disconnect cleanup is pending.',
      },
      permissions: { readEmails: true, applyLabels: true },
    }],
    healthCheckIntervalMs: 300000,
    gmail: { configured: true }, quo: { configured: true },
  } }));
  await page.route(/\/api\/connections\/gmail-1\?force=local$/, (route) => {
    forcedDeleteRequests += 1;
    return route.fulfill({ status: 204, body: '' });
  });

  await page.goto('/connections');
  const card = page.getByLabel('Gmail — info@paintersottawa.com');
  await expect(card.getByText('Cleanup pending.', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Manage info@paintersottawa.com' }).click();
  await card.getByRole('menuitem', { name: 'Retry disconnect…' }).click();
  await expect(card.getByRole('button', { name: 'Retry disconnect' })).toBeVisible();
  await card.getByRole('button', { name: 'Forget locally…' }).click();
  await expect(card.getByText('Provider access may remain active.', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Forget locally', exact: true }).click();
  await expect.poll(() => forcedDeleteRequests).toBe(1);
  await expect(page.getByText('info@paintersottawa.com forgotten locally.', { exact: true })).toBeVisible();
});
