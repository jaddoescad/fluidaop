#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const AGENT_KEY = 'email-categorizer';
const PROMPT_VERSION = 'fluid-email-categorizer-v1';
const DEFAULT_MODEL = 'nous/openai/gpt-5.6-luna';
const DEFAULT_URL = 'https://bwbckdkouqghdadpkjvn.supabase.co/functions/v1/fluid-email-categorizer';
const API_URL = (process.env.FLUID_EMAIL_CATEGORIZER_URL || DEFAULT_URL).replace(/\/$/, '');
const API_SECRET = (process.env.FLUID_EMAIL_CATEGORIZER_SECRET || '').trim();
const STATE_DIR = resolve(process.env.FLUID_EMAIL_CATEGORIZER_STATE_DIR || '/opt/data/fluid/email-categorizer');
const GMAIL_READER = resolve(process.env.OTTAWA_GMAIL_READER || '/opt/data/bin/ottawa-gmail-read');
const WORKER = `hermes-${hostname()}`.slice(0, 100);

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
  if (!parsed?.job?.leaseToken || !parsed?.signal?.external_id) {
    throw new Error('staged job is incomplete');
  }
  return parsed;
}

async function request(action, body, method = 'POST') {
  if (API_SECRET.length < 43) throw new Error('FLUID_EMAIL_CATEGORIZER_SECRET is not configured');
  const response = await fetch(`${API_URL}?action=${encodeURIComponent(action)}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-fluid-agent-secret': API_SECRET,
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
    throw new Error(`Fluid categorizer API: ${detail}`);
  }
  return payload;
}

function cleanValue(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 100_000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => cleanValue(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 1000);
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (/^(data|bytes|raw|base64|bodyData|contentBytes)$/i.test(key)) continue;
    result[key] = cleanValue(item, depth + 1);
  }
  return result;
}

function parseReaderOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('Gmail reader returned no JSON');
  try {
    return cleanValue(JSON.parse(trimmed));
  } catch {
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      try {
        return cleanValue(JSON.parse(line));
      } catch {
        // Continue to the previous line.
      }
    }
  }
  throw new Error('Gmail reader returned malformed JSON');
}

function attachmentArrays(value, depth = 0, found = []) {
  if (depth > 6 || !value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 40)) attachmentArrays(item, depth + 1, found);
    return found;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/^(attachments|files)$/i.test(key) && Array.isArray(item)) found.push(item);
    else attachmentArrays(item, depth + 1, found);
  }
  return found;
}

function firstString(item, keys) {
  for (const key of keys) {
    if (typeof item?.[key] === 'string' && item[key].trim()) return item[key].trim();
  }
  return '';
}

function normalizeAttachments(inspection) {
  const rows = attachmentArrays(inspection).flat().filter((item) => item && typeof item === 'object');
  const seen = new Set();
  const normalized = [];
  for (let index = 0; index < rows.length && normalized.length < 20; index += 1) {
    const item = rows[index];
    const filename = firstString(item, ['filename', 'fileName', 'name']);
    const attachmentKey = firstString(item, ['attachmentKey', 'attachmentId', 'attachment_id', 'partId', 'part_id', 'id']) || filename || String(index + 1);
    if (seen.has(attachmentKey)) continue;
    seen.add(attachmentKey);
    const extractedText = firstString(item, [
      'extractedText', 'extracted_text', 'ocrText', 'ocr_text', 'transcription',
      'transcript', 'text', 'textContent', 'text_content',
    ]).slice(0, 100_000);
    const rawSize = item.sizeBytes ?? item.size_bytes ?? item.size ?? null;
    const size = Number.parseInt(String(rawSize ?? ''), 10);
    const requestedStatus = firstString(item, ['status', 'extractionStatus', 'extraction_status']).toLowerCase();
    const supportedStatuses = new Set(['metadata', 'extracted', 'no_text', 'unsupported', 'failed']);
    const status = supportedStatuses.has(requestedStatus)
      ? requestedStatus
      : extractedText ? 'extracted' : 'metadata';
    const metadata = cleanValue(Object.fromEntries(
      Object.entries(item).filter(([key]) => !/^(data|bytes|raw|base64|bodyData|contentBytes|extractedText|extracted_text|ocrText|ocr_text|transcription|transcript|text|textContent|text_content)$/i.test(key)),
    ));
    normalized.push({
      attachmentKey: attachmentKey.slice(0, 500),
      filename: filename.slice(0, 500) || null,
      mimeType: firstString(item, ['mimeType', 'mime_type', 'contentType', 'content_type']).slice(0, 200) || null,
      sizeBytes: Number.isSafeInteger(size) && size >= 0 ? size : null,
      status,
      extractionMethod: firstString(item, ['extractionMethod', 'extraction_method', 'method']).slice(0, 100) || null,
      extractedText: extractedText || null,
      metadata,
    });
  }
  return normalized;
}

async function claim() {
  const limit = positiveInt(option('limit', '5'), 5, 5);
  const payload = await request('claim', { worker: WORKER, limit, leaseSeconds: 1800 });
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  for (const staged of jobs) await writeState(staged);
  console.log(JSON.stringify({
    wakeAgent: jobs.length > 0,
    agentKey: AGENT_KEY,
    promptVersion: PROMPT_VERSION,
    jobs,
  }));
}

async function inspect() {
  const jobId = option('job-id');
  const state = await readState(jobId);
  const result = spawnSync(GMAIL_READER, [
    'message', '--message-id', String(state.signal.external_id), '--json',
  ], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Gmail reader failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 1000)}`);
  }
  state.inspection = parseReaderOutput(result.stdout);
  state.attachments = normalizeAttachments(state.inspection);
  await writeState(state);
  console.log(JSON.stringify({ jobId: state.job.id, attachments: state.attachments, inspection: state.inspection }));
}

async function complete() {
  const jobId = option('job-id');
  const state = await readState(jobId);
  const labelKey = option('label-key').trim();
  const confidence = Number.parseFloat(option('confidence'));
  const reason = option('reason').trim() ||
    `Hermes selected ${labelKey} after comparing the signal with the enabled Fluid label descriptions.`;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(labelKey)) throw new Error('label key is invalid');
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('confidence must be between 0 and 1');
  if (!reason || reason.length > 1000) throw new Error('reason must be between 1 and 1000 characters');
  const attachments = Array.isArray(state.attachments) ? state.attachments : [];
  const result = await request('complete', {
    jobId: state.job.id,
    leaseToken: state.job.leaseToken,
    labelKey,
    confidence,
    reason,
    model: option('model', DEFAULT_MODEL),
    promptVersion: PROMPT_VERSION,
    evidence: {
      source: 'hermes',
      attachmentInspectionPerformed: Boolean(state.inspection),
      attachmentEvidenceCount: attachments.length,
      filenames: attachments.map((attachment) => attachment.filename).filter(Boolean),
    },
    attachments,
  });
  await unlink(jobPath(jobId)).catch(() => undefined);
  console.log(JSON.stringify(result));
}

async function fail() {
  const jobId = option('job-id');
  const state = await readState(jobId);
  const errorCode = option('error-code', 'classification-failed').trim();
  const safeErrors = {
    'attachment-inspection-failed': 'The bounded attachment inspection command failed.',
    'classification-failed': 'Hermes could not complete classification for this staged signal.',
    'completion-failed': 'The bounded Fluid completion command failed.',
  };
  const error = option('error').trim() || safeErrors[errorCode];
  if (!error) throw new Error('error-code is invalid');
  if (!error || error.length > 2000) throw new Error('error must be between 1 and 2000 characters');
  const result = await request('fail', {
    jobId: state.job.id,
    leaseToken: state.job.leaseToken,
    error,
    model: option('model', DEFAULT_MODEL),
    promptVersion: PROMPT_VERSION,
  });
  await unlink(jobPath(jobId)).catch(() => undefined);
  console.log(JSON.stringify(result));
}

async function status() {
  const payload = await request('status', {}, 'GET');
  console.log(JSON.stringify(payload));
}

async function main() {
  const command = process.argv[2] || '';
  if (command === 'claim' || command === 'precheck') return claim();
  if (command === 'inspect') return inspect();
  if (command === 'complete') return complete();
  if (command === 'fail') return fail();
  if (command === 'status') return status();
  throw new Error('usage: fluid-email-categorizer.mjs claim|inspect|complete|fail|status');
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
