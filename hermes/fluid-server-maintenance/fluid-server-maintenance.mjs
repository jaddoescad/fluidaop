#!/usr/bin/env node

const endpoint = (process.env.FLUID_SERVER_MAINTENANCE_URL || '').trim();
const secret = (process.env.FLUID_SERVER_MAINTENANCE_SECRET || '').trim();

if (!/^https:\/\//.test(endpoint)) throw new Error('FLUID_SERVER_MAINTENANCE_URL must be an HTTPS URL');
if (secret.length < 43) throw new Error('FLUID_SERVER_MAINTENANCE_SECRET is not configured');

const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-fluid-maintenance-secret': secret,
  },
  body: '{}',
  signal: AbortSignal.timeout(55_000),
});
const payload = await response.json().catch(() => null);
if (!response.ok) {
  const detail = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
  throw new Error(`Fluid server maintenance failed: ${detail}`);
}
process.stdout.write(JSON.stringify(payload));
