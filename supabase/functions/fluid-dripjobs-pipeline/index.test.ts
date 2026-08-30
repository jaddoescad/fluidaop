import { assertEquals } from 'jsr:@std/assert@1';
import { handleRequest } from './index.ts';

Deno.test('daily reconciliation endpoint requires its server-side secret', async () => {
  Deno.env.set('FLUID_DRIPJOBS_PIPELINE_SECRET', 'daily-test-secret');
  const response = await handleRequest(new Request('http://localhost?action=reconcile', {
    method: 'POST',
    headers: { 'x-fluid-agent-secret': 'wrong-secret' },
    body: '{}',
  }));
  assertEquals(response.status, 401);
});

Deno.test('daily reconciliation endpoint rejects oversized atomic bundles before database access', async () => {
  Deno.env.set('FLUID_DRIPJOBS_PIPELINE_SECRET', 'daily-test-secret');
  const response = await handleRequest(new Request('http://localhost?action=reconcile', {
    method: 'POST',
    headers: {
      'x-fluid-agent-secret': 'daily-test-secret',
      'Content-Length': String(5 * 1024 * 1024 + 1),
    },
    body: '{}',
  }));
  assertEquals(response.status, 413);
});

Deno.test('daily reconciliation endpoint requires both Sales List views', async () => {
  Deno.env.set('FLUID_DRIPJOBS_PIPELINE_SECRET', 'daily-test-secret');
  const response = await handleRequest(new Request('http://localhost?action=reconcile', {
    method: 'POST',
    headers: { 'x-fluid-agent-secret': 'daily-test-secret' },
    body: JSON.stringify({ activeRows: [], capturedAt: '2026-08-27T14:00:00Z', runKey: 'test' }),
  }));
  assertEquals(response.status, 400);
  assertEquals(await response.json(), { error: 'activeRows and archivedRows must be arrays' });
});
