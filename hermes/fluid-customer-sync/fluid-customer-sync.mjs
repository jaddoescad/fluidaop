#!/usr/bin/env node

const DEFAULT_URL = 'https://bwbckdkouqghdadpkjvn.supabase.co/functions/v1/fluid-customer-sync';
const API_URL = (process.env.FLUID_CUSTOMER_SYNC_URL || DEFAULT_URL).replace(/\/$/, '');
const API_SECRET = (
  process.env.FLUID_CUSTOMER_SYNC_SECRET ||
  process.env.FLUID_EMAIL_CATEGORIZER_SECRET ||
  ''
).trim();

async function request(action, method = 'GET') {
  if (API_SECRET.length < 43) throw new Error('Fluid customer sync authorization is not configured');
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
    throw new Error(`Fluid customer sync API: ${detail}`);
  }
  return payload;
}

function summary(status, wakeAgent = undefined) {
  return {
    ...(wakeAgent === undefined ? {} : { wakeAgent }),
    agentKey: 'customer-sync',
    sourceSystem: status?.sourceSystem || 'ottawa-painters-admin',
    sourceCustomers: Number(status?.sourceCustomers || 0),
    syncedCustomers: Number(status?.syncedCustomers || 0),
    pendingCustomers: Number(status?.pendingCustomers || 0),
    staleCustomerRoles: Number(status?.staleCustomerRoles || 0),
    linkedActivities: Number(status?.linkedActivities || 0),
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
    throw new Error('Fluid customer sync did not return a successful terminal state');
  }
  console.log(JSON.stringify({
    agentKey: 'customer-sync',
    status: result.status,
    runId: result.runId ?? null,
    sourceCustomers: Number(result.sourceCustomers || 0),
    insertedPeople: Number(result.insertedPeople || 0),
    updatedPeople: Number(result.updatedPeople || 0),
    activeCustomerPeople: Number(result.activeCustomerPeople || 0),
    activeIdentifiers: Number(result.activeIdentifiers || 0),
    changedActivityLinks: Number(result.changedActivityLinks || 0),
  }));
}

const command = process.argv[2] || '';
if (command === 'status') await status(false);
else if (command === 'precheck') await status(true);
else if (command === 'run') await run();
else throw new Error('usage: fluid-customer-sync.mjs precheck|status|run');
