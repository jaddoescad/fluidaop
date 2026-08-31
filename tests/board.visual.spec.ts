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

const hermesSchedules = [
  {
    id: 'fluid-server-maintenance-job',
    name: 'Fluid server maintenance runtime',
    profile: 'default',
    schedule: 'every 1m',
    enabled: true,
    state: 'scheduled',
    nextRunAt: '2026-08-26T02:31:00.000Z',
    lastRunAt: '2026-08-26T02:30:00.000Z',
    lastRunStatus: 'completed',
    lastError: null,
    mode: 'script',
    contractStatus: 'verified',
    contract: {
      schemaVersion: 2,
      automationKey: 'fluid-server-maintenance',
      subjectTypes: [],
      displayName: 'Fluid server maintenance — connections and Gmail queues',
      summary: 'Checks connections and processes due Gmail Signal and label queues.',
      steps: ['Run bounded server maintenance once.'],
      icon: '⚙️', definitionHash: 'sha256:test', createdAt: '2026-08-26T00:00:00.000Z',
    },
    definition: { prompt: null, promptTruncated: false, skills: [], script: 'fluid-server-maintenance.mjs', workdir: '/opt/data', model: null, timeoutSeconds: 55, definitionHash: 'sha256:test' },
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
    if (path === '/api/board/potential-leads') {
      return route.fulfill({ json: { undecidedCount: 0, items: [] } });
    }
    if (/^\/api\/board\/signals\/\d+\/read$/.test(path)) {
      return route.fulfill({ json: { activityId: Number(path.split('/')[4]), firstRead: true } });
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
    if (path === '/api/hermes/schedules') return route.fulfill({ json: { agents: hermesSchedules, fetchedAt: new Date().toISOString() } });
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

test('keeps Signals first, Potential Leads next, then the DripJobs sales stages', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('main.fl-cols > section')).toHaveCount(13);
  await expect(page.locator('main.fl-cols > section h2')).toHaveText([
    'Signals',
    'Potential Leads',
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
  await expect(page.locator('main.fl-cols > .potential-leads')).toHaveCount(1);
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
  // The recording is a compact themed player, not the browser's native slab.
  await expect(selected.locator('.fd-rec')).toBeVisible();
  await expect(selected.locator('.fd-rec-btn')).toBeVisible();
  await expect(selected.locator('audio')).toHaveAttribute('src', 'https://media.quo.com/recording.mp3');
  await expect(selected.locator('audio')).toHaveAttribute('preload', 'metadata');
  await expect(selected.getByText('completed · 42 seconds', { exact: true })).toHaveCount(0);
  // A single recording needs no label, and settled evidence shows no fillers.
  await expect(selected.getByText('Recording 1', { exact: true })).toHaveCount(0);
  await expect(selected.getByText('Waiting for Quo', { exact: false })).toHaveCount(0);
  await expect(selected.getByText('Quo is still preparing', { exact: false })).toHaveCount(0);
  await expect(selected.getByText('Customer requested an exterior estimate.', { exact: true })).toBeVisible();
  await expect(selected.getByText('Send the estimate by Friday.', { exact: true })).toBeVisible();
  await selected.getByText('Read the call transcript', { exact: true }).click();
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
  let acceptRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes('/recommendations/22222222-2222-4222-8222-222222222222/accept')) acceptRequests += 1;
  });
  await page.goto('/');
  await openSignal(page);
  await expect(popupAbove(page).locator('.cv-marker')).toHaveText('this one');
  await expect(page.locator('.fc.lw')).toHaveCount(0);
  await expect(popupAbove(page).locator('.fd-sel-text').getByText('Can you send me the company website?', { exact: true })).toBeVisible();
  const recommendation = page.getByRole('button', { name: 'Reply to the message' });
  await expect(recommendation).toBeEnabled();
  await expect(popupAbove(page).locator('.fc-replies').getByRole('button')).toHaveCount(1);
  await expect.poll(() => acceptRequests).toBe(0);
  await recommendation.click();
  await expect.poll(() => acceptRequests).toBe(1);
  await expect(page.getByText('Action created. Hermes is drafting it now; review it in Actions.')).toBeVisible();
  await expect(page.getByText('A reply draft is ready in Actions.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open draft action' })).toBeVisible();
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

test('reveals the selected Signal and its initial history together after a shared skeleton', async ({ page }) => {
  const initialHistory = Array.from({ length: 2 }, (_, index) => ({
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
  const skeleton = body.locator('.cv-skeleton');
  await expect(skeleton).toBeVisible();
  await expect(selectedSignal).toHaveCount(0);
  await expect(page.getByText('Initial history 1', { exact: true })).toHaveCount(0);
  const skeletonTop = await skeleton.locator('.cv-turn').first().evaluate(
    (element) => element.getBoundingClientRect().top,
  );

  releaseHistory();
  const firstHistory = page.getByText('Initial history 1', { exact: true });
  await expect(firstHistory).toBeVisible();
  await expect(selectedSignal).toBeVisible();
  await expect(skeleton).toHaveCount(0);
  const loadedTop = await firstHistory.locator('xpath=ancestor::article').evaluate(
    (element) => element.getBoundingClientRect().top,
  );
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

  expect(Math.abs(loadedTop - skeletonTop)).toBeLessThan(2);
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
  const selectedSignal = popupAbove(page).locator('.cv-turn.cv-marked');
  await expect(loadEarlier).toBeAttached();
  await expect(currentAnchor).toBeAttached();
  await expect(selectedSignal).toBeVisible();

  const finalMessageBottomGap = await body.evaluate((element) => {
    const selected = element.querySelector<HTMLElement>('.cv-turn.cv-marked');
    return selected
      ? element.getBoundingClientRect().bottom - selected.getBoundingClientRect().bottom
      : 0;
  });
  expect(finalMessageBottomGap).toBeGreaterThanOrEqual(39);

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

test('Send records a simulation without contacting Gmail or creating an outbound Signal', async ({ page }) => {
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
  await expect(page.getByText(/No Gmail request was made, no outbound Signal was created/)).toBeVisible();
  expect(providerWriteRequests).toBe(0);
});

test('a pending Signal with no recommendation stays available for review without inventing an action', async ({ page }) => {
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
  await expect(popupAbove(page).locator('.fc-status-review')).toHaveText('needs a decision');
  await expect(popupAbove(page).locator('.cv-turn.cv-marked')).toContainText(signal.preview);
  await expect(popupAbove(page).locator('.fc-replies')).toBeHidden();
});

test('an outbound Signal opens read-only without a redundant decision message', async ({ page }) => {
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
  const selected = popupAbove(page).locator('.cv-turn.cv-marked');
  await expect(popupAbove(page).locator('.fd-dec')).toHaveCount(0);
  await expect(selected.locator('.cv-sender')).toHaveText('You');
  await expect(selected.locator('.src-direction-label')).toHaveText('Sent');
  await expect(selected).toContainText(outboundSignal.preview);
  await expect(popupAbove(page).locator('.fc-replies')).toBeHidden();
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

test('Activity shows every Hermes tick and opens its stored Signal results', async ({ page }) => {
  const execution = {
    activityId: 'test-activity', id: 'execution-1', automationKey: 'potential-lead-classifier',
    automationName: 'Potential Lead Classifier — inbound email, text, call → Potential Leads',
    automationMode: 'agent', jobId: 'job-1', jobName: 'Potential Lead runtime', profile: 'default',
    status: 'completed', source: 'cron', attempt: 1, startedAt: '2026-08-26T02:29:00.000Z',
    finishedAt: '2026-08-26T02:29:09.000Z', error: null, sessionId: 'session-1',
    model: 'nous/openai/gpt-5.6-luna', messageCount: 4, toolCallCount: 2,
    outcome: 'Potential lead identified', resultCount: 1,
  };
  const noWork = {
    ...execution, activityId: 'test-no-work', id: 'execution-2', automationKey: 'fluid-server-maintenance',
    automationName: 'Fluid server maintenance — connections and Gmail queues', automationMode: 'script',
    sessionId: null, model: null, messageCount: null, toolCallCount: null,
    outcome: 'Script completed with no linked Signal result.', resultCount: 0,
  };
  await page.route('**/api/activity?*', (route) => route.fulfill({ json: {
    items: [execution, noWork], nextCursor: null,
  } }));
  await page.route('**/api/activity/test-activity', (route) => route.fulfill({ json: {
    activity: execution,
    results: [{
      id: 'run-1', status: 'completed', model: execution.model, promptVersion: 'v2', error: null,
      subject: { type: 'signal', id: String(signal.id) },
      signal: { id: signal.id, subject: signal.subject, preview: signal.preview, event_type: 'message.received', actor_name: person.displayName, occurred_at: signal.occurredAt },
      result: { schemaVersion: 1, kind: 'potential-lead-verdict', title: 'Potential lead identified', summary: 'Asked for a painting quote.', payload: { verdict: 'lead' } },
    }],
  } }));

  await page.goto('/activity');
  await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
  await expect(page.getByText('Script completed with no linked Signal result.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Potential Lead Classifier/ }).click();
  await expect(page).toHaveURL(/\/activity\/test-activity$/);
  await expect(page.getByRole('heading', { name: 'Potential lead identified', level: 3 })).toBeVisible();
  await expect(page.getByRole('link', { name: /Open Signal/ })).toHaveAttribute('href', `/?signal=${signal.id}`);
});

test('Signal Agent activity keeps queue lifecycle rows separate and links real runs', async ({ page }) => {
  const baseEvent = {
    runId: null, jobId: '41', agentKey: 'potential-lead-classifier',
    automationName: 'Potential Lead Classifier — inbound email, text, call → Potential Leads',
    activityId: null, finishedAt: null, model: null, error: null, skipReason: null,
    verdict: null, confidence: null, summary: null, runtime: null, result: null,
    recommendationCount: null, triage: null, legacy: false, orphaned: false, warning: null,
  };
  await page.route(`**/api/board/signals/${signal.id}?*`, (route) => route.fulfill({ json: {
    signal, recommendations: [], history: [], historyNextCursor: null, attachments: [],
    transcript: null, recordings: null, callSummary: null,
    agentActivity: [
      { ...baseEvent, id: 'event:1', status: 'queued', at: '2026-08-26T02:28:00.000Z', queue: { status: 'succeeded', attempt: 0, availableAt: '2026-08-26T02:28:00.000Z', claimedAt: null, finishedAt: null } },
      { ...baseEvent, id: 'event:2', runId: 'run-1', activityId: 'test-activity', status: 'completed', at: '2026-08-26T02:29:09.000Z', finishedAt: '2026-08-26T02:29:09.000Z', model: 'nous/openai/gpt-5.6-luna', verdict: 'lead', confidence: 0.91, summary: 'Asked for a quote', runtime: { provider: 'hermes', profile: 'default', jobId: 'job-1', executionId: 'execution-1', sessionId: 'session-1' }, result: { schemaVersion: 1, kind: 'potential-lead-verdict', title: 'Potential lead identified', summary: 'Asked for a quote', payload: { verdict: 'lead' } }, queue: { status: 'succeeded', attempt: 1, availableAt: null, claimedAt: '2026-08-26T02:29:00.000Z', finishedAt: '2026-08-26T02:29:09.000Z' } },
    ],
  } }));

  await page.goto('/');
  await openSignal(page);
  await expect(page.locator('.fd-agents-row')).toHaveCount(2);
  await page.locator('details.fd-agents-row summary').click();
  await expect(page.getByText('Queue job 41 · attempt 0', { exact: true })).toBeVisible();
  await expect(page.locator('a.fd-agents-row')).toHaveAttribute('href', '/activity/test-activity');
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
  const skeleton = page.locator('.board-skeleton');
  await expect(skeleton).toBeVisible();
  await expect(skeleton).toHaveAttribute('aria-busy', 'true');
  await expect(skeleton).toHaveAccessibleName('Loading Board…');
  await page.waitForTimeout(150);
  await expect(skeleton).toBeVisible();
  releasePipeline();
  await expect(skeleton).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Labels unavailable');
});

test('keeps Gmail permissions in Connections and recurring work in Schedules', async ({ page }) => {
  await page.goto('/connections');
  await expect(page.getByLabel('Gmail — info@paintersottawa.com')).toContainText('Read emails · Apply labels');
  await expect(page.getByText('Gmail label sync', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Fluid labels active', { exact: true })).toHaveCount(0);

  await page.goto('/schedules');
  await expect(page.getByText('Fluid server maintenance — connections and Gmail queues', { exact: true })).toBeVisible();
  await expect(page.getByText('every 1m', { exact: true })).toBeVisible();
  await expect(page.locator('.sc-badge-script')).toHaveCount(1);

  await page.goto('/agents');
  await expect(page.getByText('Fluid server maintenance — connections and Gmail queues', { exact: true })).toHaveCount(0);
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

test('an unread Signal is counted, marked, and recedes once opened', async ({ page }) => {
  const readRequests: string[] = [];
  await page.route('**/api/board/signals**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/board/signals') {
      return route.fulfill({ json: { items: [{ ...signal, readAt: null }], unreadCount: 1, nextCursor: null } });
    }
    if (path === `/api/board/signals/${signal.id}/read`) {
      readRequests.push(route.request().method());
      return route.fulfill({ json: { activityId: signal.id, firstRead: true } });
    }
    return route.fallback();
  });

  await page.goto('/');
  const badge = page.locator('.fl-signals .pane-count');
  await expect(badge).toHaveText('1');
  await expect(badge).toHaveClass(/is-alert/);
  await expect(badge).toHaveAttribute('title', '1 unread Signal');
  const card = page.locator('.fl-sig');
  await expect(card).toHaveClass(/is-unread/);
  await expect(card.locator('.fl-sig-unread')).toHaveCount(1);

  await card.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect.poll(() => readRequests).toEqual(['POST']);
  await expect(card).toHaveClass(/is-read/);
  await expect(card).not.toHaveClass(/is-unread/);
  await expect(card.locator('.fl-sig-unread')).toHaveCount(0);
  await expect(badge).toHaveText('0');
  await expect(badge).not.toHaveClass(/is-alert/);
});

test('Potential Leads take a verdict without leaving the column, and open as a Signal', async ({ page }) => {
  const inquiry = {
    id: 71,
    activityId: 61950,
    name: 'Pat Prospect',
    email: 'pat@example.com',
    phone: null,
    claimedName: null,
    claimedEmail: null,
    claimedPhone: null,
    signalCount: 1,
    firstSeenAt: '2026-08-26T01:10:00.000Z',
    lastSeenAt: '2026-08-26T01:10:00.000Z',
    summary: 'Wants a quote for a two-storey exterior in Kanata',
    reason: 'Direct request for a quote from an unknown sender',
    confidence: 0.91,
    disposition: 'undecided',
    decidedBy: null,
    decidedAt: null,
    createdAt: '2026-08-26T01:12:00.000Z',
    // They wrote, we called back the same day: one lit "they wrote" cell.
    touches: {
      outbound: 1, inbound: 1, automated: 0,
      lastAt: '2026-08-26T01:40:00.000Z', lastDirection: 'outbound',
      phase: 'first_contact', phaseLabel: 'First contact',
      phaseStartedAt: '2026-08-26T01:10:00.000Z', evidenceKind: 'exact',
      days: [3], daysBefore: 0,
    },
    signal: {
      subject: 'Quote for exterior',
      preview: 'Hi, can you quote our exterior?',
      occurredAt: '2026-08-26T01:10:00.000Z',
      direction: 'inbound',
      source: 'gmail',
      eventType: 'email.received',
      actorName: 'Pat Prospect',
      callStatus: null,
      durationSeconds: null,
      callSummary: null,
      transcriptStatus: null,
    },
  };
  const missedCall = {
    ...inquiry,
    id: 72,
    activityId: 61951,
    name: null,
    email: null,
    phone: '+16135550177',
    signalCount: 3,
    firstSeenAt: '2026-08-24T23:40:00.000Z',
    lastSeenAt: '2026-08-24T23:40:00.000Z',
    summary: '',
    reason: 'Missed call from an unknown number',
    confidence: 0.55,
    createdAt: '2026-08-24T23:42:00.000Z',
    // Nobody has called back in over a day: the missed call is the only lit
    // cell, followed by a day of silence.
    touches: {
      ...inquiry.touches,
      outbound: 0,
      lastAt: '2026-08-24T23:40:00.000Z', lastDirection: 'inbound',
      phaseStartedAt: '2026-08-24T23:40:00.000Z',
      days: [3, 0],
    },
    signal: {
      ...inquiry.signal,
      subject: 'Incoming call',
      preview: 'missed',
      occurredAt: '2026-08-24T23:40:00.000Z',
      source: 'quo',
      eventType: 'call.completed',
      actorName: null,
      callStatus: 'missed',
      durationSeconds: 0,
      transcriptStatus: 'unavailable',
    },
  };
  const candidates = new Map([[inquiry.id, inquiry], [missedCall.id, missedCall]]);
  const decisions: Array<{ id: number; disposition: string }> = [];
  const listing = () => {
    const items = [...candidates.values()];
    return {
      undecidedCount: items.filter((item) => item.disposition === 'undecided').length,
      items: [
        ...items.filter((item) => item.disposition === 'undecided'),
        ...items.filter((item) => item.disposition !== 'undecided'),
      ],
    };
  };
  await page.route('**/api/board/potential-leads**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const decision = /^\/api\/board\/potential-leads\/(\d+)\/disposition$/.exec(path);
    if (decision && route.request().method() === 'POST') {
      const id = Number(decision[1]);
      const { disposition } = route.request().postDataJSON() as { disposition: string };
      const current = candidates.get(id);
      if (!current) return route.fulfill({ status: 404, json: { error: 'Lead candidate not found' } });
      decisions.push({ id, disposition });
      candidates.set(id, {
        ...current,
        disposition,
        decidedBy: disposition === 'undecided' ? null : 'manager',
        decidedAt: disposition === 'undecided' ? null : '2026-08-26T02:30:00.000Z',
      });
      return route.fulfill({ json: { id, disposition, decidedAt: '2026-08-26T02:30:00.000Z' } });
    }
    if (path === '/api/board/potential-leads') return route.fulfill({ json: listing() });
    return route.fallback();
  });
  let releaseCandidateDetail!: () => void;
  const candidateDetailReleased = new Promise<void>((resolve) => { releaseCandidateDetail = resolve; });
  await page.route(`**/api/board/signals/${inquiry.activityId}**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/board/signals/${inquiry.activityId}/read`) {
      return route.fulfill({ json: { activityId: inquiry.activityId, firstRead: true } });
    }
    await candidateDetailReleased;
    return route.fulfill({ json: {
      signal: {
        id: inquiry.activityId,
        source: 'gmail',
        eventType: 'email.received',
        direction: 'inbound',
        actorName: 'Pat Prospect',
        actorEmail: 'pat@example.com',
        actorPhone: null,
        subject: 'Quote for exterior',
        preview: 'Hi, can you quote our exterior?',
        bodyText: 'Hi, can you quote our exterior? Two storey, Kanata.',
        currentMessageText: 'Hi, can you quote our exterior? Two storey, Kanata.',
        occurredAt: '2026-08-26T01:10:00.000Z',
        contact: null,
        labels: [],
        attachmentCount: 0,
        review: { status: 'pending', resolution: null, pendingRecommendationCount: 0 },
        readAt: null,
      },
      recommendations: [],
      history: [],
      historyNextCursor: null,
      attachments: [],
    } });
  });

  await page.goto('/');
  const column = page.locator('.potential-leads');
  const badge = column.locator('.pane-head .pane-count');
  await expect(badge).toHaveText('2');
  await expect(badge).toHaveClass(/is-alert/);
  await expect(column.locator('.potential-lead')).toHaveCount(2);
  await expect(column.locator('.pipeline-archive-divider')).toHaveCount(0);

  const inquiryCard = column.locator('[data-candidate-id="71"]');
  await expect(inquiryCard.locator('h3')).toHaveText('Pat Prospect');
  await expect(inquiryCard.locator('.potential-lead-contact a')).toHaveText(['pat@example.com']);
  await expect(inquiryCard.locator('.pipeline-card-message')).toHaveText('Wants a quote for a two-storey exterior in Kanata');
  await expect(inquiryCard.locator('.src')).toHaveText('Email · Gmail');
  const callCard = column.locator('[data-candidate-id="72"]');
  await expect(callCard.locator('h3')).toHaveText('+1 613 555 0177');
  await expect(callCard.locator('.pipeline-card-message')).toHaveText('Missed call');
  await expect(callCard.locator('.src')).toHaveText('Call · Quo');
  // One card per contact: repeat signals show as a count, never as extra cards.
  await expect(callCard.locator('.potential-lead-count')).toHaveText('3 signals');
  await expect(inquiryCard.locator('.potential-lead-count')).toHaveCount(0);

  // The same day squares as the pipeline: one cell per day since first
  // contact, and an unanswered lead runs hot after a day of silence.
  await expect(inquiryCard.locator('.pipeline-day')).toHaveCount(1);
  await expect(inquiryCard.locator('.pipeline-day')).toHaveClass(/is-l3/);
  await expect(inquiryCard.locator('.pipeline-touch-label')).toHaveText('1 touch point · 1 from them');
  await expect(inquiryCard.locator('.pipeline-touches')).toHaveAttribute('data-heat', 'cool');
  await expect(callCard.locator('.pipeline-day')).toHaveCount(2);
  await expect(callCard.locator('.pipeline-day').last()).toHaveClass(/is-l0/);
  await expect(callCard.locator('.pipeline-touch-label')).toHaveText('No touch points · 1 from them');
  await expect(callCard.locator('.pipeline-touch-when')).toHaveText('1d ago');
  await expect(callCard.locator('.pipeline-touches')).toHaveAttribute('data-heat', 'hot');

  // A verdict re-files the card under Decided; it does not remove it.
  await inquiryCard.getByRole('button', { name: 'Lead', exact: true }).click();
  await expect.poll(() => decisions).toEqual([{ id: 71, disposition: 'lead' }]);
  await expect(column.locator('.pipeline-archive-divider')).toContainText('Decided');
  await expect(column.locator('.potential-lead')).toHaveCount(2);
  await expect(inquiryCard).toHaveClass(/is-lead/);
  await expect(inquiryCard.locator('.potential-lead-verdict')).toHaveText('✓ Lead');
  await expect(inquiryCard).toContainText('waiting for a CRM Contact');
  await expect(badge).toHaveText('1');
  await expect(column.locator('.potential-lead').nth(0)).toHaveAttribute('data-candidate-id', '72');
  await expect(column.locator('.potential-lead').nth(1)).toHaveAttribute('data-candidate-id', '71');

  await callCard.getByRole('button', { name: 'Not a lead', exact: true }).click();
  await expect.poll(() => decisions.length).toBe(2);
  await expect(callCard).toHaveClass(/is-not_lead/);
  await expect(badge).toHaveText('0');
  await expect(badge).not.toHaveClass(/is-alert/);
  await expect(column.locator('.empty-note')).toContainText('Nothing new');
  // Marked leads sit above not-leads: they still need a DripJobs contact.
  await expect(column.locator('.potential-lead').nth(0)).toHaveAttribute('data-candidate-id', '71');
  await expect(column.locator('.potential-lead').nth(1)).toHaveAttribute('data-candidate-id', '72');

  await callCard.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => decisions.length).toBe(3);
  await expect(callCard).not.toHaveClass(/is-not_lead/);
  await expect(badge).toHaveText('1');

  // Opening a card shows the communication with who they are and how to reach them.
  await inquiryCard.locator('.pipeline-card-open').click();
  const popup = page.locator('.fc:not(.lw)');
  await expect(popup).toBeVisible();
  await expect(popup.locator('.fc-head-sub')).toContainText('for Pat Prospect · potential lead');
  const band = popup.locator('.potential-lead-band');
  await expect(band.locator('dd').nth(0)).toHaveText('Pat Prospect');
  await expect(band.locator('dd a')).toHaveAttribute('href', 'mailto:pat@example.com');
  await expect(band.locator('dd').nth(2)).toHaveText('Not given');
  await expect(band).toContainText('91% sure');
  await expect(band.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await expect(popup.locator('.cv-skeleton')).toBeVisible();
  await expect(popup.locator('.cv-turn.cv-marked')).toHaveCount(0);
  releaseCandidateDetail();
  await expect(popup.locator('.cv-turn.cv-marked')).toContainText('Hi, can you quote our exterior? Two storey, Kanata.');
  await expect(popup.locator('.cv-skeleton')).toHaveCount(0);
  await expect(popup.locator('.cv-turn.cv-marked .cv-sender')).toHaveText('Pat Prospect');
});
