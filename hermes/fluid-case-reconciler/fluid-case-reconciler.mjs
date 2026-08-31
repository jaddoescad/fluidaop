#!/usr/bin/env node

import { hostname } from 'node:os';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const AGENT_KEY = 'case-reconciler';
const PROMPT_VERSION = 'fluid-case-reconciler-v1';
const DEFAULT_MODEL = 'nous/openai/gpt-5.6-luna';
const DEFAULT_URL = 'https://fskrxkiujtfuxntcrjam.supabase.co/functions/v1/fluid-operational-context';
const API_URL = (process.env.FLUID_OPERATIONAL_CONTEXT_URL || DEFAULT_URL).replace(/\/$/, '');
const API_SECRET = (
  process.env.FLUID_OPERATIONAL_CONTEXT_SECRET ||
  ''
).trim();
const STATE_DIR = resolve(process.env.FLUID_CASE_RECONCILER_STATE_DIR || '/opt/data/fluid/case-reconciler');
const WORKER = `hermes-${hostname()}-case-reconciler`.slice(0, 100);

const ASSERTION_KINDS = new Set([
  'request', 'decision', 'commitment', 'blocker', 'schedule_change',
  'scope_change', 'completion_claim',
]);
const ACTION_KINDS = new Set([
  'schedule_job', 'assign_project_manager', 'assign_crew', 'follow_up',
  'review_scope_change', 'resolve_blocker', 'confirm_decision', 'collect_balance',
]);
const REASON_CODES = new Set([
  'customer-request', 'team-commitment', 'blocker', 'scope-change',
  'schedule-change', 'payment-needed', 'decision-needed',
]);

function option(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function positiveInt(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function jobPath(jobId) {
  if (!/^\d+$/.test(String(jobId))) throw new Error('job id must be a positive integer');
  return resolve(STATE_DIR, `${jobId}.json`);
}

async function writeState(state) {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const target = jobPath(state.job.id);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}

async function readState(jobId) {
  const parsed = JSON.parse(await readFile(jobPath(jobId), 'utf8'));
  if (!parsed?.job?.leaseToken || !parsed?.case?.id || !parsed?.businessJob?.id) {
    throw new Error('staged case-reconciliation job is incomplete');
  }
  parsed.draft ??= { assertions: [], proposals: [] };
  return parsed;
}

async function request(action, body = {}, method = 'POST') {
  if (API_SECRET.length < 43) throw new Error('Fluid operational-context authorization is not configured');
  const response = await fetch(`${API_URL}?action=${encodeURIComponent(action)}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-fluid-activity-secret': API_SECRET,
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(45_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
    throw new Error(`Fluid operational-context API: ${detail}`);
  }
  return payload;
}

function evidenceIds(state) {
  const raw = option('evidence-ids').trim();
  if (!raw || !/^\d+(?:,\d+){0,9}$/.test(raw)) throw new Error('evidence-ids must contain one to ten numeric ids');
  const values = [...new Set(raw.split(',').map(Number))];
  const available = new Set((state.evidence || []).map((item) => Number(item.id)));
  if (values.some((value) => !available.has(value))) throw new Error('evidence id is not in the staged Case context');
  return values;
}

function confidence() {
  const parsed = Number.parseFloat(option('confidence'));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error('confidence must be between 0 and 1');
  return parsed;
}

function boundedEvidenceText(state, ids) {
  const evidence = (state.evidence || []).find((item) => ids.includes(Number(item.id)));
  const text = String(evidence?.subject || evidence?.text || '').replace(/\s+/g, ' ').trim();
  return text.slice(0, 760) || 'The linked evidence requires operational review.';
}

function proposalCopy(state, actionKind, reasonCode) {
  const name = String(state.businessJob?.name || 'this Job').replace(/\s+/g, ' ').trim().slice(0, 120);
  const title = {
    schedule_job: `Review the schedule for ${name}`,
    assign_project_manager: `Assign a project manager for ${name}`,
    assign_crew: `Assign a crew for ${name}`,
    follow_up: `Follow up on ${name}`,
    review_scope_change: `Review a scope change for ${name}`,
    resolve_blocker: `Resolve a blocker for ${name}`,
    confirm_decision: `Confirm a decision for ${name}`,
    collect_balance: `Review the remaining balance for ${name}`,
  }[actionKind];
  const reason = {
    'customer-request': 'Recent linked evidence contains a customer request that is not resolved by the current Case state.',
    'team-commitment': 'Recent linked evidence contains a team commitment that is not yet reflected as completed.',
    blocker: 'Recent linked evidence identifies an unresolved operational blocker.',
    'scope-change': 'Recent linked evidence indicates a scope change that needs review against the current Job state.',
    'schedule-change': 'Recent linked evidence indicates a scheduling change that is not confirmed by the structured schedule.',
    'payment-needed': 'The current financial state and linked evidence indicate that payment follow-up may still be required.',
    'decision-needed': 'Recent linked evidence identifies a decision that still needs confirmation.',
  }[reasonCode];
  return { title, reason };
}

async function claim() {
  const limit = positiveInt(option('limit', '3'), 3, 5);
  const jobs = [];
  for (let index = 0; index < limit; index += 1) {
    const staged = await request('claim', { worker: WORKER, leaseSeconds: 900 });
    if (!staged?.job) break;
    staged.draft = { assertions: [], proposals: [] };
    await writeState(staged);
    jobs.push(staged);
  }
  console.log(JSON.stringify({ wakeAgent: jobs.length > 0, agentKey: AGENT_KEY, promptVersion: PROMPT_VERSION, jobs }));
}

async function inspect() {
  const state = await readState(option('job-id'));
  console.log(JSON.stringify({
    job: state.job,
    case: state.case,
    businessJob: state.businessJob,
    contact: state.contact,
    workItems: state.workItems,
    evidence: state.evidence,
    draft: state.draft,
  }));
}

async function addAssertion() {
  const jobId = option('job-id');
  const state = await readState(jobId);
  const kind = option('kind').trim();
  if (!ASSERTION_KINDS.has(kind)) throw new Error('assertion kind is invalid');
  const ids = evidenceIds(state);
  const row = {
    kind,
    summary: boundedEvidenceText(state, ids),
    confidence: confidence(),
    evidenceIds: ids,
  };
  state.draft.assertions = (state.draft.assertions || []).filter((item) =>
    !(item.kind === row.kind && JSON.stringify(item.evidenceIds) === JSON.stringify(row.evidenceIds))
  );
  state.draft.assertions.push(row);
  if (state.draft.assertions.length > 20) throw new Error('a Case may have at most twenty staged assertions');
  await writeState(state);
  console.log(JSON.stringify({ jobId: state.job.id, assertion: row }));
}

async function addProposal() {
  const jobId = option('job-id');
  const state = await readState(jobId);
  const actionKind = option('action-kind').trim();
  const reasonCode = option('reason-code').trim();
  if (!ACTION_KINDS.has(actionKind)) throw new Error('action kind is invalid');
  if (!REASON_CODES.has(reasonCode)) throw new Error('reason code is invalid');
  const ids = evidenceIds(state);
  const waitingRaw = option('waiting', 'false');
  if (!['true', 'false'].includes(waitingRaw)) throw new Error('waiting must be true or false');
  const dueDaysRaw = option('due-days', '');
  const dueDays = dueDaysRaw ? positiveInt(dueDaysRaw, 0, 365) : 0;
  if (dueDaysRaw && dueDays === 0) throw new Error('due-days must be between 1 and 365');
  const copy = proposalCopy(state, actionKind, reasonCode);
  const row = {
    actionKind,
    targetKey: `${actionKind}:${reasonCode}`,
    ...copy,
    confidence: confidence(),
    waiting: waitingRaw === 'true',
    dueAt: dueDays > 0 ? new Date(Date.now() + dueDays * 86_400_000).toISOString() : null,
    owner: null,
    prerequisites: {
      caseRevision: state.case.revision,
      reasonCode,
      canonicalProductionStatus: state.case.canonicalState?.production?.status ?? null,
      canonicalFinancialStatus: state.case.canonicalState?.financial?.status ?? null,
      evidenceIds: ids,
    },
    evidenceIds: ids,
  };
  state.draft.proposals = (state.draft.proposals || []).filter((item) => item.targetKey !== row.targetKey);
  state.draft.proposals.push(row);
  if (state.draft.proposals.length > 8) throw new Error('a Case may have at most eight staged proposals');
  await writeState(state);
  console.log(JSON.stringify({ jobId: state.job.id, proposal: row }));
}

async function complete() {
  const jobId = option('job-id');
  const state = await readState(jobId);
  const result = await request('complete', {
    jobId: state.job.id,
    leaseToken: state.job.leaseToken,
    model: option('model', DEFAULT_MODEL),
    promptVersion: PROMPT_VERSION,
    assertions: state.draft.assertions || [],
    proposals: state.draft.proposals || [],
  });
  await unlink(jobPath(jobId)).catch(() => undefined);
  console.log(JSON.stringify(result));
}

async function fail() {
  const jobId = option('job-id');
  const state = await readState(jobId);
  const errorCode = option('error-code', 'reconciliation-failed');
  const messages = {
    'reconciliation-failed': 'Hermes could not reconcile this staged Case.',
    'completion-failed': 'The bounded Fluid Case completion command failed.',
  };
  if (!messages[errorCode]) throw new Error('error-code is invalid');
  const result = await request('fail', {
    jobId: state.job.id,
    leaseToken: state.job.leaseToken,
    error: messages[errorCode],
    model: option('model', DEFAULT_MODEL),
    promptVersion: PROMPT_VERSION,
  });
  await unlink(jobPath(jobId)).catch(() => undefined);
  console.log(JSON.stringify(result));
}

async function status() {
  console.log(JSON.stringify(await request('shadow-status', {}, 'GET')));
}

async function reconcile() {
  const limit = positiveInt(option('limit', '500'), 500, 5000);
  console.log(JSON.stringify(await request('reconcile', { limit })));
}

const command = process.argv[2] || '';
if (command === 'claim' || command === 'precheck') await claim();
else if (command === 'inspect') await inspect();
else if (command === 'assert') await addAssertion();
else if (command === 'propose') await addProposal();
else if (command === 'complete') await complete();
else if (command === 'fail') await fail();
else if (command === 'status') await status();
else if (command === 'reconcile') await reconcile();
else throw new Error('usage: fluid-case-reconciler.mjs claim|inspect|assert|propose|complete|fail|status|reconcile');
