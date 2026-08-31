#!/usr/bin/env node

const DEFAULT_URL = 'https://fskrxkiujtfuxntcrjam.supabase.co/functions/v1/fluid-customer-sync';
const API_URL = (process.env.FLUID_CUSTOMER_SYNC_URL || DEFAULT_URL).replace(/\/$/, '');
const API_SECRET = (
  process.env.FLUID_CUSTOMER_SYNC_SECRET ||
  ''
).trim();

async function request(action, method = 'GET') {
  if (API_SECRET.length < 43) throw new Error('Fluid lead sync authorization is not configured');
  const response = await fetch(`${API_URL}?action=${encodeURIComponent(action)}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      'x-fluid-agent-secret': API_SECRET,
    },
    ...(method === 'POST' ? { body: '{}' } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
    throw new Error(`Fluid lead sync API: ${detail}`);
  }
  return payload;
}

function summary(status, wakeAgent = undefined) {
  return {
    ...(wakeAgent === undefined ? {} : { wakeAgent }),
    agentKey: 'lead-sync',
    sourceSystem: status?.sourceSystem || 'ottawa-painters-admin',
    sourceLeads: Number(status?.sourceLeads || 0),
    syncedLeads: Number(status?.syncedLeads || 0),
    pendingLeads: Number(status?.pendingLeads || 0),
    staleLeadRoles: Number(status?.staleLeadRoles || 0),
    linkedActivities: Number(status?.linkedActivities || 0),
    identityDrift: Number(status?.identityHealth?.driftCount || 0),
    needsSync: Boolean(status?.needsSync),
    lastRunStatus: status?.lastRun?.status || null,
    lastRunFinishedAt: status?.lastRun?.finishedAt || null,
  };
}

async function status(precheck = false) {
  const result = await request('status');
  console.log(JSON.stringify(summary(result, precheck ? Boolean(result?.needsSync) : undefined)));
}

async function run() {
  const result = await request('run', 'POST');
  if (!result || !['succeeded', 'skipped'].includes(result.status)) {
    throw new Error('Fluid lead sync did not return a successful terminal state');
  }
  console.log(JSON.stringify({
    agentKey: 'lead-sync',
    status: result.status,
    runId: result.runId ?? null,
    sourceLeads: Number(result.sourceLeads || 0),
    syncedLeads: Number(result.syncedLeads || 0),
    pendingLeads: Number(result.pendingLeads || 0),
    staleLeadRoles: Number(result.staleLeadRoles || 0),
    insertedPeople: Number(result.insertedPeople || 0),
    updatedPeople: Number(result.updatedPeople || 0),
    activeLeadPeople: Number(result.activeLeadPeople || 0),
    activeIdentifiers: Number(result.activeIdentifiers || 0),
    changedActivityLinks: Number(result.changedActivityLinks || 0),
    identitySeeding: result.identitySeeding || null,
    identityReconciliation: result.identityReconciliation || null,
  }));
}

const command = process.argv[2] || '';
if (command === 'status') await status(false);
else if (command === 'precheck') await status(true);
else if (command === 'run') await run();
else throw new Error('usage: fluid-customer-sync.mjs precheck|status|run');
