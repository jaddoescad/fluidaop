import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithTimeoutAndRetry } from './httpClient.js';

test('safe reads retry once by default', async () => {
  let calls = 0;
  const response = await fetchWithTimeoutAndRetry('https://example.test', {}, {
    request: async () => {
      calls += 1;
      return new Response(null, { status: calls === 1 ? 503 : 200 });
    },
  });

  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});

test('unsafe writes are never retried', async () => {
  let calls = 0;
  const response = await fetchWithTimeoutAndRetry('https://example.test', { method: 'POST' }, {
    safeRetries: 5,
    request: async () => {
      calls += 1;
      return new Response(null, { status: 503 });
    },
  });

  assert.equal(response.status, 503);
  assert.equal(calls, 1);
});

test('an explicit caller signal is preserved', async () => {
  const controller = new AbortController();
  await fetchWithTimeoutAndRetry('https://example.test', { signal: controller.signal }, {
    request: async (_input, init) => {
      assert.equal(init?.signal, controller.signal);
      return new Response(null, { status: 200 });
    },
  });
});
