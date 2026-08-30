import { assertEquals } from 'jsr:@std/assert@1';
import { handleRequest, normalizeStageEvent } from './index.ts';

Deno.test('requires Fluid webhook authentication before parsing the payload', async () => {
  Deno.env.set('FLUID_DRIPJOBS_EVENTS_SECRET', 'test-secret');
  const response = await handleRequest(new Request('http://localhost', {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-secret' },
    body: '{}',
  }));
  assertEquals(response.status, 401);
});

Deno.test('accepts only exact DripJobs stage-change payloads', () => {
  assertEquals(normalizeStageEvent({
    version: 1,
    event_type: 'deal.stage_changed',
    event_id: 'provider-123',
    deal_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    deal_stage: 'Cold Leads',
    previous_stage: 'New Lead',
    changed_at: '2026-08-27T14:00:00Z',
  }), {
    dealId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    changedAt: '2026-08-27T14:00:00.000Z',
    providerEventId: 'provider-123',
    stage: 'Cold Leads',
    previousStage: 'New Lead',
  });
});

Deno.test('rejects Ottawa operational webhook event types', async () => {
  Deno.env.set('FLUID_DRIPJOBS_EVENTS_SECRET', 'test-secret');
  const response = await handleRequest(new Request('http://localhost', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-secret' },
    body: JSON.stringify({
      version: 1,
      event_type: 'lead.created',
      deal_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      created_at: '2026-08-27T14:00:00Z',
    }),
  }));
  assertEquals(response.status, 400);
  assertEquals(await response.json(), { error: 'Unsupported event_type' });
});
