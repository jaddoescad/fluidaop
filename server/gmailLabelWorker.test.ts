import assert from 'node:assert/strict';
import test from 'node:test';
import { GmailLabelApiError } from './gmailLabelSync.js';
import {
  GmailLabelSyncClaim,
  GmailLabelWorkerDependencies,
  runGmailLabelSyncBatch,
} from './gmailLabelWorker.js';

function claimedJob(): GmailLabelSyncClaim {
  return {
    job: {
      id: 7,
      leaseToken: '11111111-1111-4111-8111-111111111111',
      generation: 3,
      attempts: 1,
      claimedAt: '2026-08-30T12:00:00.000Z',
    },
    message: { activityId: 42, accountEmail: 'info@example.com', externalId: 'gmail-42' },
    desiredLabel: { id: 2, key: 'quote', name: 'Quote' },
    topicLabels: [{ id: 2, key: 'quote', name: 'Quote' }],
    mappings: [],
    roleLabels: ['Employee'],
    managedRoleLabels: ['Employee'],
  };
}

function dependencies(
  overrides: Partial<GmailLabelWorkerDependencies> = {},
): GmailLabelWorkerDependencies {
  return {
    maxJobs: 1,
    claim: async () => claimedJob(),
    project: async () => ({ outcome: 'applied', gmailLabelId: 'Label_1', gmailLabelName: 'Quote' }),
    complete: async () => undefined,
    fail: async () => undefined,
    ...overrides,
  };
}

test('Gmail label worker completes a successfully projected claim', async () => {
  const completions: unknown[] = [];
  const result = await runGmailLabelSyncBatch(dependencies({
    complete: async (completion) => { completions.push(completion); },
  }));
  assert.deepEqual(result, { claimed: 1, completed: 1, failed: 0 });
  assert.deepEqual(completions, [{
    jobId: 7,
    leaseToken: '11111111-1111-4111-8111-111111111111',
    generation: 3,
    outcome: 'applied',
    gmailLabelId: 'Label_1',
    gmailLabelName: 'Quote',
  }]);
});

test('Gmail label worker stops cleanly when no claim is available', async () => {
  let claims = 0;
  const result = await runGmailLabelSyncBatch(dependencies({
    maxJobs: 5,
    claim: async () => { claims += 1; return { job: null }; },
  }));
  assert.deepEqual(result, { claimed: 0, completed: 0, failed: 0 });
  assert.equal(claims, 1);
});

test('Gmail label worker stops claiming when its connection begins disconnecting', async () => {
  let active = true;
  let claims = 0;
  const result = await runGmailLabelSyncBatch(dependencies({
    maxJobs: 5,
    shouldContinue: () => active,
    claim: async () => { claims += 1; return claimedJob(); },
    complete: async () => { active = false; },
  }));

  assert.deepEqual(result, { claimed: 1, completed: 1, failed: 0 });
  assert.equal(claims, 1);
});

test('Gmail label worker rejects malformed claimed jobs before projection', async () => {
  await assert.rejects(runGmailLabelSyncBatch(dependencies({
    claim: async () => ({ job: claimedJob().job }),
  })), /invalid claimed job/);
});

test('Gmail label worker reports Gmail rate limits as retryable', async () => {
  const failures: unknown[] = [];
  const result = await runGmailLabelSyncBatch(dependencies({
    project: async () => { throw new GmailLabelApiError(429, 'rate limited', 17); },
    fail: async (failure) => { failures.push(failure); },
  }));
  assert.equal(result.failed, 1);
  assert.deepEqual(failures, [{
    jobId: 7,
    leaseToken: '11111111-1111-4111-8111-111111111111',
    generation: 3,
    error: 'rate limited',
    retryable: true,
    retryAfterSeconds: 17,
  }]);
});

test('Gmail label worker reports non-Gmail failures as terminal', async () => {
  const failures: Array<{ retryable: boolean; retryAfterSeconds: number | null }> = [];
  const result = await runGmailLabelSyncBatch(dependencies({
    project: async () => { throw new Error('invalid label plan'); },
    fail: async (failure) => { failures.push(failure); },
  }));
  assert.equal(result.failed, 1);
  assert.equal(failures[0]?.retryable, false);
  assert.equal(failures[0]?.retryAfterSeconds, null);
});

test('Gmail label worker leaves a projected job leased when completion fails', async () => {
  let failureCalls = 0;
  await assert.rejects(runGmailLabelSyncBatch(dependencies({
    complete: async () => { throw new Error('database temporarily unavailable'); },
    fail: async () => { failureCalls += 1; },
  })), /database temporarily unavailable/);
  assert.equal(failureCalls, 0);
});
