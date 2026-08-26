import { expect, test } from '@playwright/test';

const person = {
  id: '11111111-1111-4111-8111-111111111111',
  displayName: 'Chuck Furey',
  primaryEmail: 'chuck@example.com',
  primaryPhone: '+16135550123',
  entityType: 'person',
  roles: ['customer'],
  needsAttention: true,
  pendingRecommendationCount: 1,
  recentSignalCount: 4,
  latestActivityAt: '2026-08-25T14:30:00.000Z',
  urgency: 'Follow up',
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
        nextCheckAt: '2026-08-26T02:35:00.000Z', error: null,
        permissions: { readEmails: true, applyLabels: true },
      }],
      healthCheckIntervalMs: 300000,
      gmail: { configured: true }, quo: { configured: true }, slack: { configured: true },
    } });
    if (path.startsWith('/api/board/')) return route.fulfill({ json: { items: [], nextCursor: null } });
    return route.fulfill({ status: 404, json: { error: 'Not mocked' } });
  });
});

test('uses canonical urgency colors and dims contacts without a bright signal', async ({ page }) => {
  const settledPerson = {
    ...person,
    id: '44444444-4444-4444-8444-444444444444',
    displayName: 'Jane Settled',
    // The API flag may be broad/stale; brightness follows the actual Signal cards.
    needsAttention: true,
    pendingRecommendationCount: 0,
    urgency: 'Waiting on them',
  };
  await page.route('**/api/board/people**', (route) => route.fulfill({
    json: { items: [settledPerson, person], nextCursor: null, count: 2 },
  }));

  await page.goto('/');

  const bright = page.locator('.fl-person').filter({ hasText: person.displayName });
  const dim = page.locator('.fl-person').filter({ hasText: settledPerson.displayName });
  await expect(page.locator('.fl-person .fl-pname')).toHaveText([person.displayName, settledPerson.displayName]);
  await expect(bright).toHaveClass(/signal-bright/);
  await expect(dim).toHaveClass(/signal-dim/);
  await expect(bright.locator('.canonical-label')).toHaveText('Follow up');
  await expect(dim.locator('.canonical-label')).toHaveText('Waiting on them');
  await expect(bright.locator('.canonical-label')).toHaveCSS('color', 'rgb(157, 151, 245)');
  await expect(dim.locator('.canonical-label')).toHaveCSS('color', 'rgb(76, 196, 184)');
  await expect(bright).toHaveCSS('opacity', '1');
  await expect(dim).toHaveCSS('opacity', '0.48');
});

test('keeps the fixed five-column Board visual contract', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('main.fl-cols > section')).toHaveCount(5);
  await expect(page.locator('main.fl-cols > section h2')).toHaveText([
    'People',
    'Signals',
    'Actions',
    'Reminders',
    'Automations',
  ]);
  await expect(page.getByText('Open', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Waiting', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Recently completed', { exact: true })).toHaveCount(0);
  await expect(page.locator('.fl-cols')).toHaveScreenshot('real-board-five-columns.png', {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixels: 10,
  });
});

test('an enabled recommendation creates one Action only after the user clicks', async ({ page }) => {
  let settleRequests = 0;
  let acceptRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes(`/api/board/signals/${signal.id}/settle`)) settleRequests += 1;
    if (request.url().includes('/recommendations/22222222-2222-4222-8222-222222222222/accept')) acceptRequests += 1;
  });
  await page.goto('/');
  await expect(page.locator('.fl-sig-head .fl-sig-name')).toHaveText('Chuck Furey');
  await page.locator('.fl-sig').click();
  await expect(page.getByText('Selected Signal', { exact: true })).toBeVisible();
  await expect(page.locator('.fc .fd-sel-text').getByText('Can you send me the company website?', { exact: true })).toBeVisible();
  const recommendation = page.getByRole('button', { name: 'Reply to the message' });
  await expect(recommendation).toBeEnabled();
  await expect(page.getByRole('button', { name: 'No action needed' })).toBeEnabled();
  await expect.poll(() => settleRequests).toBe(0);
  await recommendation.click();
  await expect.poll(() => acceptRequests).toBe(1);
  await expect.poll(() => settleRequests).toBe(0);
  await expect(page.getByText('Action created. Hermes is drafting it now; review it in Actions.')).toBeVisible();
  await expect(page.getByText('A reply draft is ready in Actions.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open draft action' })).toBeVisible();
  await page.getByRole('button', { name: 'Open draft action' }).click();
  await expect(page.getByRole('button', { name: 'Send (simulation)' })).toBeVisible();
  await page.getByTitle('Close (Esc)').click();
  await expect(page.locator('.fl-sig').first()).toContainText('Chuck Furey');
  await expect(page.locator('.fl-sig').first()).toContainText('Draft in Actions');
  await expect(page.locator('.fl-sig').first()).toHaveScreenshot('signal-action-open-card.png', {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixels: 10,
  });
  await expect(page.getByText('Draft an answer about the company website', { exact: true })).toBeVisible();
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

  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
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
  await page.locator('.fl-sig').click();

  const selected = page.locator('.fd-sel');
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
  await expect(page.locator('.fc')).toHaveScreenshot('signal-decision-glanceable.png', {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixels: 10,
  });
  await selected.getByText('Show quoted history', { exact: true }).click();
  await expect(quoted).toBeVisible();
  await expect(quoted).toContainText('The project is tentatively scheduled for October.');
  await expect(selected.getByText('Hide quoted history', { exact: true })).toBeVisible();

  const historySources = page.locator('.fc .fd-turn .src');
  await expect(historySources).toHaveText(['SMS · Quo', 'Call · Quo', 'Email · Gmail']);
  await expect(page.locator('.fc .fd-turn .src-direction-label')).toHaveText(['Sent', 'Received', 'Sent']);

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
  await page.locator('.fl-sig').click();

  const body = page.locator('.fc-body');
  const selectedSignal = page.locator('.fd-sel');
  const decisionControls = page.locator('.fc-replies');
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
    const selected = element.querySelector<HTMLElement>('.fd-sel');
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
  await page.locator('.fl-sig').click();

  const body = page.locator('.fc-body');
  const loadEarlier = page.getByRole('button', { name: 'Load earlier history' });
  const currentAnchor = page.getByText('Current history 1', { exact: true });
  await expect(loadEarlier).toBeAttached();
  await expect(currentAnchor).toBeAttached();

  const controlComesFirst = await body.evaluate((element) => {
    const control = element.querySelector<HTMLButtonElement>('button.fc-chip');
    const firstMessage = element.querySelector<HTMLElement>('.fd-turn');
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
  await page.locator('.fl-sig').click();
  await page.getByRole('button', { name: 'Reply to the message' }).click();
  await page.getByRole('button', { name: '✕' }).click();
  await page.getByText('Draft an answer about the company website', { exact: true }).click();
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
  await page.locator('.fl-sig').click();
  await expect(page.getByText('Hermes has no suggested action. You still need to decide whether this Signal needs one.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'No action needed' })).toBeEnabled();
  await page.waitForTimeout(250);
  expect(settleRequests).toBe(0);
  await page.getByRole('button', { name: 'No action needed' }).click();
  await expect.poll(() => settleRequests).toBe(1);
});

test('shows only live user-created Actions and Reminders', async ({ page }) => {
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
  await expect(page.getByText('Confirm the colour choice', { exact: true })).toBeVisible();
  await expect(page.getByText('Call tomorrow morning', { exact: true })).toBeVisible();
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
  await expect(page.getByRole('switch', { name: 'Enable Draft SMS reply' })).toBeDisabled();
  await expect(page.locator('main.fl-cols')).toHaveCount(0);
});

test('the agent roster scrolls while sidebar settings stay fixed', async ({ page }) => {
  const agents = Array.from({ length: 24 }, (_, index) => ({
    id: `agent-${index}`,
    name: `agent-${index}`,
    profile: 'default',
    schedule: 'every 5 minutes',
    enabled: true,
    state: 'scheduled',
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastError: null,
    mode: 'agent' as const,
    contract: {
      schemaVersion: 1,
      displayName: `Agent ${index + 1}`,
      summary: 'Handles operational work.',
      steps: ['Review', 'Act'],
      icon: '🤖',
      definitionHash: `hash-${index}`,
      createdAt: null,
    },
    contractStatus: 'verified',
  }));
  await page.route('**/api/hermes/schedules', (route) => route.fulfill({
    json: { agents, fetchedAt: new Date().toISOString() },
  }));

  await page.goto('/');
  await expect(page.getByText('Agent 24', { exact: true })).toBeAttached();

  const roster = page.locator('.fl-nav-agents');
  const footer = page.locator('.fl-nav-foot');
  await expect.poll(() => roster.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(await page.evaluate(() => window.innerHeight));

  const footerTop = await footer.evaluate((element) => element.getBoundingClientRect().top);
  await roster.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  expect(await roster.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await footer.evaluate((element) => element.getBoundingClientRect().top)).toBe(footerTop);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('keeps Gmail permissions in Connections and recurring work in Schedules', async ({ page }) => {
  await page.goto('/connections');
  await expect(page.getByLabel('Gmail — info@paintersottawa.com')).toContainText('Read emails · Apply labels');
  await expect(page.getByText('Gmail label sync', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Fluid labels active', { exact: true })).toHaveCount(0);

  await page.goto('/schedules');
  await expect(page.getByText('Gmail inbox sync', { exact: true })).toBeVisible();
  await expect(page.getByText('Gmail label sync', { exact: true })).toBeVisible();
  await expect(page.locator('.sc-badge-script')).toHaveCount(2);

  await page.goto('/agents');
  await expect(page.getByText('Gmail inbox sync', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Gmail label sync', { exact: true })).toHaveCount(0);
});
