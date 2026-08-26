#!/usr/bin/env node
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const baseUrl = (process.env.FLUID_ACTION_RUNNER_URL ??
  'https://bwbckdkouqghdadpkjvn.supabase.co/functions/v1/fluid-action-runner').replace(/\/$/, '');
const secret = process.env.FLUID_ACTION_RUNNER_SECRET ?? process.env.FLUID_SIGNAL_RECOMMENDER_SECRET ?? process.env.FLUID_EMAIL_CATEGORIZER_SECRET ?? '';
const stateDir = process.env.FLUID_ACTION_RUNNER_STATE_DIR ?? '/opt/data/fluid/action-runner';
const promptVersion = 'action-runner-v1';
const model = process.env.FLUID_ACTION_RUNNER_MODEL ?? 'hermes';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}
function jobPath(jobId) { return join(stateDir, `job-${jobId}.json`); }
function draftPath(jobId) { return join(stateDir, `draft-${jobId}.txt`); }

async function request(action, method = 'GET', body) {
  if (secret.length < 43) throw new Error('FLUID_ACTION_RUNNER_SECRET is missing');
  const response = await fetch(`${baseUrl}?action=${encodeURIComponent(action)}`, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-fluid-agent-secret': secret },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Fluid returned HTTP ${response.status}`);
  return payload;
}

async function claim() {
  const payload = await request('claim', 'POST', {
    worker: `hermes-action-runner-${process.pid}`,
    limit: positiveInteger(argument('limit'), 5, 10),
    leaseSeconds: 900,
  });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  for (const item of payload.jobs ?? []) await writeFile(jobPath(item.job.id), JSON.stringify(item), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ wakeAgent: (payload.jobs?.length ?? 0) > 0, agentKey: payload.agentKey, jobs: payload.jobs ?? [] }));
}

async function complete() {
  const jobId = positiveInteger(argument('job-id'), 0, Number.MAX_SAFE_INTEGER);
  if (!jobId) throw new Error('--job-id is required');
  const staged = JSON.parse(await readFile(jobPath(jobId), 'utf8'));
  const inlineBody = argument('draft-body');
  const requestedPath = argument('draft-file', draftPath(jobId));
  if (!inlineBody && resolve(requestedPath) !== resolve(draftPath(jobId))) throw new Error('Draft file must use the staged job path');
  const draftBody = (inlineBody ?? await readFile(requestedPath, 'utf8')).trim();
  if (!draftBody || draftBody.length > 50_000) throw new Error('Draft body must contain 1 to 50,000 characters');
  const payload = await request('complete', 'POST', {
    jobId, leaseToken: staged.job.leaseToken, draftBody, model, promptVersion,
  });
  await unlink(jobPath(jobId)).catch(() => undefined);
  if (!inlineBody) await unlink(draftPath(jobId)).catch(() => undefined);
  process.stdout.write(JSON.stringify(payload));
}

async function fail() {
  const jobId = positiveInteger(argument('job-id'), 0, Number.MAX_SAFE_INTEGER);
  if (!jobId) throw new Error('--job-id is required');
  const code = argument('error-code', 'drafting-failed');
  if (!new Set(['drafting-failed', 'context-insufficient', 'completion-failed']).has(code)) throw new Error('Invalid failure code');
  const staged = JSON.parse(await readFile(jobPath(jobId), 'utf8'));
  const payload = await request('fail', 'POST', { jobId, leaseToken: staged.job.leaseToken, error: code });
  await Promise.all([unlink(jobPath(jobId)).catch(() => undefined), unlink(draftPath(jobId)).catch(() => undefined)]);
  process.stdout.write(JSON.stringify(payload));
}

const command = process.argv[2] ?? 'status';
try {
  if (command === 'claim') await claim();
  else if (command === 'complete') await complete();
  else if (command === 'fail') await fail();
  else if (command === 'status') process.stdout.write(JSON.stringify(await request('status')));
  else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
