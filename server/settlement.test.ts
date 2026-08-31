import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPositiveSignalId,
  signalSettlementPayload,
} from './settlement.js';

test('signal settlement derives the local-only RPC payload', () => {
  assert.deepEqual(signalSettlementPayload('42'), {
    activityId: '42',
    resolution: 'no_action',
    reviewer: 'manager',
  });
});

test('signal settlement rejects invalid or out-of-range IDs', () => {
  for (const value of ['', '0', '-1', '01', '1.2', '9223372036854775808']) {
    assert.equal(isPositiveSignalId(value), false, value);
  }
  assert.equal(isPositiveSignalId('9223372036854775807'), true);
});
