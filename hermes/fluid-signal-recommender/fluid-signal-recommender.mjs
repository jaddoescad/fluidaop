#!/usr/bin/env node
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const baseUrl = (process.env.FLUID_SIGNAL_RECOMMENDER_URL ??
  'https://bwbckdkouqghdadpkjvn.supabase.co/functions/v1/fluid-signal-recommender').replace(/\/$/, '');
const secret = process.env.FLUID_SIGNAL_RECOMMENDER_SECRET ?? process.env.FLUID_EMAIL_CATEGORIZER_SECRET ?? '';
const stateDir = process.env.FLUID_SIGNAL_RECOMMENDER_STATE_DIR ?? '/opt/data/fluid/signal-recommender';
const promptVersion = 'signal-recommender-v2';
const model = process.env.FLUID_SIGNAL_RECOMMENDER_MODEL ?? 'hermes';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function jobPath(jobId) {
  return join(stateDir, `job-${jobId}.json`);
}

function resultPath(jobId) {
  return join(stateDir, `result-${jobId}.json`);
}

async function request(action, method = 'GET', body) {
  if (secret.length < 43) throw new Error('FLUID_SIGNAL_RECOMMENDER_SECRET is missing');
  const response = await fetch(`${baseUrl}?action=${encodeURIComponent(action)}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-fluid-agent-secret': secret,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Fluid returned HTTP ${response.status}`);
  return payload;
}

async function claim() {
  const limit = positiveInteger(argument('limit'), 5, 10);
  const payload = await request('claim', 'POST', {
    worker: `hermes-signal-recommender-${process.pid}`,
    limit,
    leaseSeconds: 900,
  });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  for (const item of payload.jobs ?? []) {
    await writeFile(jobPath(item.job.id), JSON.stringify(item), { mode: 0o600 });
  }
  process.stdout.write(JSON.stringify({
    wakeAgent: (payload.jobs?.length ?? 0) > 0,
    agentKey: payload.agentKey,
    jobs: payload.jobs ?? [],
  }));
}

function bounded(value, maximum, label) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > maximum) throw new Error(`Invalid ${label}`);
  return result;
}

function recommendationsFrom(payload, staged) {
  if (!payload || !Array.isArray(payload.recommendations) || payload.recommendations.length > 1) {
    throw new Error('Result must contain at most one recommendation');
  }
  if (payload.recommendations.length === 0) return [];
  const item = payload.recommendations[0];
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid recommendation object');
  const actionDefinitionKey = bounded(item.actionDefinitionKey, 100, 'Action definition key');
  const definition = staged.actionDefinitions?.find((candidate) => candidate.key === actionDefinitionKey);
  if (!definition || definition.handler !== 'draft-email-reply') throw new Error('Action definition is not enabled and executable');
  const confidence = Number(item.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('Invalid confidence');
  const caseId = item.caseId === null || item.caseId === undefined ? null : bounded(item.caseId, 100, 'Case id');
  if (caseId && !staged.cases?.some((candidate) => candidate.id === caseId)) throw new Error('Case is not linked to this Signal');
  const evidence = Array.isArray(item.evidence) ? item.evidence.slice(0, 30) : [{ type: 'activity', id: staged.signal?.id }];
  return [{
    actionDefinitionKey,
    buttonText: bounded(item.buttonText, 160, 'button text'),
    reason: bounded(item.reason, 2000, 'reason'),
    confidence,
    caseId,
    evidence,
    prerequisites: {
      signalStillCurrent: true,
      sourceActivityRevision: staged.signal?.recommendationRevision,
      actionDefinitionVersion: definition.version,
      ...(caseId ? { caseRevision: staged.cases.find((candidate) => candidate.id === caseId)?.revision } : {}),
    },
  }];
}

async function complete() {
  const jobId = positiveInteger(argument('job-id'), 0, Number.MAX_SAFE_INTEGER);
  if (!jobId) throw new Error('--job-id is required');
  const staged = JSON.parse(await readFile(jobPath(jobId), 'utf8'));
  const noRecommendation = argument('recommendations') === 'none';
  const inlineDefinition = argument('action-definition');
  let recommendations;
  if (noRecommendation) {
    recommendations = [];
  } else if (inlineDefinition) {
    recommendations = recommendationsFrom({ recommendations: [{
      actionDefinitionKey: inlineDefinition,
      buttonText: argument('button-text'),
      reason: argument('reason'),
      confidence: argument('confidence'),
      caseId: argument('case-id') === 'none' ? null : argument('case-id'),
      evidence: [{ type: 'activity', id: staged.signal?.id }],
    }] }, staged);
  } else {
    const requestedPath = argument('result-file', resultPath(jobId));
    if (resolve(requestedPath) !== resolve(resultPath(jobId))) throw new Error('Result file must use the staged job path');
    recommendations = recommendationsFrom(JSON.parse(await readFile(requestedPath, 'utf8')), staged);
  }
  const payload = await request('complete', 'POST', {
    jobId,
    leaseToken: staged.job.leaseToken,
    model,
    promptVersion,
    recommendations,
  });
  await unlink(jobPath(jobId)).catch(() => undefined);
  if (!noRecommendation && !inlineDefinition) await unlink(resultPath(jobId)).catch(() => undefined);
  process.stdout.write(JSON.stringify(payload));
}

async function fail() {
  const jobId = positiveInteger(argument('job-id'), 0, Number.MAX_SAFE_INTEGER);
  if (!jobId) throw new Error('--job-id is required');
  const allowed = new Set(['recommendation-failed', 'context-insufficient', 'completion-failed']);
  const code = argument('error-code', 'recommendation-failed');
  if (!allowed.has(code)) throw new Error('Invalid failure code');
  const staged = JSON.parse(await readFile(jobPath(jobId), 'utf8'));
  const payload = await request('fail', 'POST', {
    jobId,
    leaseToken: staged.job.leaseToken,
    error: code,
    model,
    promptVersion,
  });
  await unlink(jobPath(jobId)).catch(() => undefined);
  process.stdout.write(JSON.stringify(payload));
}

async function reconcile() {
  process.stdout.write(JSON.stringify(await request('reconcile', 'POST', {
    limit: positiveInteger(argument('limit'), 500, 5000),
  })));
}

async function status() {
  process.stdout.write(JSON.stringify(await request('status')));
}

const command = process.argv[2] ?? 'status';
try {
  if (command === 'claim') await claim();
  else if (command === 'complete') await complete();
  else if (command === 'fail') await fail();
  else if (command === 'reconcile') await reconcile();
  else if (command === 'status') await status();
  else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
