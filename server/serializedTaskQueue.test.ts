import assert from 'node:assert/strict';
import test from 'node:test';
import { SerializedTaskQueue } from './serializedTaskQueue.js';

test('a failed task does not poison later serialized writes', async () => {
  const queue = new SerializedTaskQueue();
  const calls: string[] = [];
  await assert.rejects(queue.run(async () => {
    calls.push('failed');
    throw new Error('disk full');
  }), /disk full/);
  await queue.run(async () => {
    calls.push('recovered');
  });
  assert.deepEqual(calls, ['failed', 'recovered']);
});

test('a disconnect queued after connect wins the connection state race', async () => {
  const queue = new SerializedTaskQueue();
  let state = 'initial';
  const connect = queue.run(async () => { state = 'connected'; });
  const disconnect = queue.run(async () => { state = 'disconnected'; });
  await Promise.all([connect, disconnect]);
  assert.equal(state, 'disconnected');
});

test('an explicit reconnect queued after disconnect wins the connection state race', async () => {
  const queue = new SerializedTaskQueue();
  let state = 'connected';
  const disconnect = queue.run(async () => { state = 'disconnected'; });
  const reconnect = queue.run(async () => { state = 'connected'; });
  await Promise.all([disconnect, reconnect]);
  assert.equal(state, 'connected');
});
