import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { app } from './index.js';

let baseUrl = '';
let server: ReturnType<typeof app.listen>;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test('Activity detail rejects an unverified opaque identifier', async () => {
  const response = await fetch(`${baseUrl}/api/activity/not-a-real-activity`);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Activity id is invalid' });
});

test('Hermes server maintenance requires its dedicated secret', async () => {
  const response = await fetch(`${baseUrl}/api/internal/hermes-maintenance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Unauthorized' });
});

test('Express preserves malformed JSON as 400', async () => {
  const response = await fetch(`${baseUrl}/api/connections/quo/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{invalid',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Request body contains invalid JSON' });
});

test('Express preserves oversized JSON as 413', async () => {
  const response = await fetch(`${baseUrl}/api/connections/quo/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 'x'.repeat(100_000) }),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'Request body is too large' });
});

test('removed manual Signal settlement endpoint stays unavailable', async () => {
  const response = await fetch(`${baseUrl}/api/board/signals/123/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 404);
});
