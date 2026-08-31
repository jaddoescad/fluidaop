import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canForceRemoveConnection,
  failedDisconnectUpdate,
  googleRevocationIsComplete,
  pendingDisconnectUpdate,
} from './disconnectPolicy.js';

test('disconnect remains pending and retryable after provider cleanup failure', () => {
  const started = pendingDisconnectUpdate('2026-08-30T12:00:00.000Z');
  const failed = failedDisconnectUpdate('provider unavailable', '2026-08-30T12:01:00.000Z');
  assert.equal(started.disconnectPending, true);
  assert.equal(failed.disconnectPending, true);
  assert.match(failed.error, /^Disconnect pending:/);
  assert.equal(pendingDisconnectUpdate('2026-08-30T12:02:00.000Z').disconnectPending, true);
});

test('force removal is limited to a previously pending disconnect', () => {
  assert.equal(canForceRemoveConnection(undefined), false);
  assert.equal(canForceRemoveConnection(false), false);
  assert.equal(canForceRemoveConnection(true), true);
});

test('Google revocation treats invalid or already-revoked tokens as complete', () => {
  for (const status of [200, 204, 400, 401]) assert.equal(googleRevocationIsComplete(status), true);
  for (const status of [403, 429, 500]) assert.equal(googleRevocationIsComplete(status), false);
});
