#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const AGENT_KEY = 'signal-triage';
const PROMPT_VERSION = 'fluid-signal-triage-v1';
const DEFAULT_MODEL = 'nous/openai/gpt-5.6-luna';
const DEFAULT_URL = 'https://bwbckdkouqghdadpkjvn.supabase.co/functions/v1/fluid-signal-triage';
const API_URL = (process.env.FLUID_SIGNAL_TRIAGE_URL || DEFAULT_URL).replace(/\/$/, '');
const API_SECRET = (
  process.env.FLUID_SIGNAL_TRIAGE_SECRET ||
  process.env.FLUID_EMAIL_CATEGORIZER_SECRET ||
  ''
).trim();
const STATE_DIR = resolve(process.env.FLUID_SIGNAL_TRIAGE_STATE_DIR || '/opt/data/fluid/signal-triage');
const GMAIL_READER = resolve(process.env.OTTAWA_GMAIL_READER || '/opt/data/bin/ottawa-gmail-read');
const GMAIL_READER_LIB_URL = process.env.OTTAWA_GMAIL_READER_LIB_URL ||
  'file:///opt/data/bin/lib/ottawa-gmail-read.mjs';
const GMAIL_TOKEN_LIB_URL = process.env.OTTAWA_GMAIL_TOKEN_LIB_URL ||
  'file:///opt/data/bin/lib/ottawa-customer-rag.mjs';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const EXTRACTABLE_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);
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
  if (API_SECRET.length < 43) throw new Error('Fluid signal-triage authorization is not configured');
  const response = await fetch(`${API_URL}?action=${encodeURIComponent(action)}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-fluid-agent-secret': API_SECRET,
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(45_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
    throw new Error(`Fluid signal-triage API: ${detail}`);
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
    for (const line of trimmed.split(/\r?\n/).reverse()) {
      try {
        return cleanValue(JSON.parse(line));
      } catch {
        // Continue to the previous line.
      }
    }
  }
  throw new Error('Gmail reader returned malformed JSON');
}

function inferredMimeType(filename, mimeType) {
  const normalized = String(mimeType || '').trim().toLowerCase().split(';', 1)[0];
  if (EXTRACTABLE_MIME_TYPES.has(normalized)) return normalized;
  const lowerName = String(filename || '').trim().toLowerCase();
  if (lowerName.endsWith('.pdf')) return 'application/pdf';
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  return normalized || 'application/octet-stream';
}

function rawAttachmentParts(part, results = []) {
  if (!part || typeof part !== 'object') return results;
  const filename = String(part.filename || '').trim();
  const attachmentId = String(part.body?.attachmentId || '').trim();
  if (filename || attachmentId) {
    results.push({
      attachmentId: attachmentId || null,
      filename,
      mimeType: inferredMimeType(filename, part.mimeType),
      sizeBytes: Number.isFinite(Number(part.body?.size)) ? Number(part.body.size) : null,
    });
  }
  for (const child of part.parts || []) rawAttachmentParts(child, results);
  return results;
}

function decodeBase64UrlBytes(value) {
  const normalized = String(value || '').replaceAll('-', '+').replaceAll('_', '/');
  try {
    return Buffer.from(normalized, 'base64');
  } catch {
    return Buffer.alloc(0);
  }
}

function boundedEnvInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
  return Math.max(minimum, Math.min(maximum, Number(raw)));
}

async function enrichAttachmentText(state, inspection) {
  const attachments = Array.isArray(inspection?.attachments) ? inspection.attachments : [];
  const maximumAttachments = boundedEnvInteger('HERMES_GMAIL_MAX_ATTACHMENTS', 3, 1, 5);
  const maximumBytes = boundedEnvInteger('HERMES_GMAIL_MAX_ATTACHMENT_BYTES', 5_000_000, 64_000, 10_000_000);
  const maximumText = boundedEnvInteger('HERMES_GMAIL_MAX_ATTACHMENT_TEXT', 6_000, 500, 10_000);
  const candidates = attachments
    .filter((attachment) => !String(attachment?.content_text || '').trim())
    .filter((attachment) => EXTRACTABLE_MIME_TYPES.has(inferredMimeType(attachment?.filename, attachment?.mime_type)))
    .slice(0, maximumAttachments);
  if (candidates.length === 0) return inspection;

  const [{ googleAccessToken }, { extractAttachmentText }] = await Promise.all([
    import(GMAIL_TOKEN_LIB_URL),
    import(GMAIL_READER_LIB_URL),
  ]);
  const token = await googleAccessToken(process.env, fetch);
  const messageId = String(state.signal.external_id);
  const messageResponse = await fetch(`${GMAIL_API}/messages/${encodeURIComponent(messageId)}?format=full`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  const message = await messageResponse.json().catch(() => ({}));
  if (!messageResponse.ok) throw new Error(`Gmail message attachment read failed with HTTP ${messageResponse.status}`);
  const rawParts = rawAttachmentParts(message.payload);

  for (const attachment of candidates) {
    const exact = rawParts.find((part) => part.filename === attachment.filename) || rawParts[attachments.indexOf(attachment)];
    const mimeType = inferredMimeType(attachment.filename, exact?.mimeType || attachment.mime_type);
    attachment.mime_type = mimeType;
    if (!exact?.attachmentId) {
      attachment.content_status = 'content_unavailable';
      continue;
    }
    if (exact.sizeBytes !== null && exact.sizeBytes > maximumBytes) {
      attachment.content_status = 'too_large';
      continue;
    }
    const contentResponse = await fetch(
      `${GMAIL_API}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(exact.attachmentId)}`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      },
    );
    const content = await contentResponse.json().catch(() => ({}));
    if (!contentResponse.ok) {
      attachment.content_status = `http_${contentResponse.status}`;
      continue;
    }
    const bytes = decodeBase64UrlBytes(content.data);
    if (bytes.length === 0 || bytes.length > maximumBytes) {
      attachment.content_status = bytes.length === 0 ? 'empty' : 'too_large';
      continue;
    }
    const extracted = await extractAttachmentText({ bytes, mimeType, maximumText });
    attachment.content_status = extracted.status;
    if (extracted.text) attachment.content_text = extracted.text;
  }
  return inspection;
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
      'transcript', 'text', 'textContent', 'text_content', 'content_text',
    ]).slice(0, 100_000);
    const rawSize = item.sizeBytes ?? item.size_bytes ?? item.size ?? null;
    const size = Number.parseInt(String(rawSize ?? ''), 10);
    const requestedStatus = firstString(item, [
      'status', 'extractionStatus', 'extraction_status', 'contentStatus', 'content_status',
    ]).toLowerCase();
    const supportedStatuses = new Set(['metadata', 'extracted', 'no_text', 'unsupported', 'failed']);
    const status = supportedStatuses.has(requestedStatus)
      ? requestedStatus
      : requestedStatus.startsWith('extracted') || extractedText
        ? 'extracted'
        : requestedStatus === 'no_text_found'
          ? 'no_text'
          : requestedStatus === 'unsupported_type'
            ? 'unsupported'
            : /(?:failed|timeout|invalid|http_)/.test(requestedStatus)
              ? 'failed'
              : 'metadata';
    normalized.push({
      attachmentKey: attachmentKey.slice(0, 500),
      filename: filename.slice(0, 500) || null,
      mimeType: firstString(item, ['mimeType', 'mime_type', 'contentType', 'content_type']).slice(0, 200) || null,
      sizeBytes: Number.isSafeInteger(size) && size >= 0 ? size : null,
      status,
      extractionMethod: firstString(item, ['extractionMethod', 'extraction_method', 'method']).slice(0, 100) || null,
      extractedText: extractedText || null,
      metadata: cleanValue(Object.fromEntries(Object.entries(item).filter(([key]) =>
        !/^(data|bytes|raw|base64|bodyData|contentBytes|extractedText|extracted_text|ocrText|ocr_text|transcription|transcript|text|textContent|text_content)$/i.test(key)
      ))),
    });
  }
  return normalized;
}

function boundedDisplayName(state) {
  const candidates = [
    state?.signal?.actor_name,
    ...(Array.isArray(state?.identities) ? state.identities.map((identity) => identity?.displayName) : []),
  ];
  const candidate = candidates.find((value) => typeof value === 'string' && value.trim());
  return typeof candidate === 'string' ? candidate.trim().slice(0, 300) : '';
}

async function claim() {
  const limit = positiveInt(option('limit', '5'), 5, 5);
  const payload = await request('claim', { worker: WORKER, limit, leaseSeconds: 900 });
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  for (const staged of jobs) await writeState(staged);
  console.log(JSON.stringify({ wakeAgent: jobs.length > 0, agentKey: AGENT_KEY, promptVersion: PROMPT_VERSION, jobs }));
}

async function inspect() {
  const jobId = option('job-id');
  const state = await readState(jobId);
  if (state.signal.source !== 'gmail') {
    state.attachments = [];
    await writeState(state);
    console.log(JSON.stringify({ jobId: state.job.id, skipped: true, reason: 'not-gmail' }));
    return;
  }
  const result = spawnSync(GMAIL_READER, ['message', '--message-id', String(state.signal.external_id), '--json'], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Gmail reader failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 1000)}`);
  }
  state.inspection = await enrichAttachmentText(state, parseReaderOutput(result.stdout));
  state.attachments = normalizeAttachments(state.inspection);
  await writeState(state);
  console.log(JSON.stringify({ jobId: state.job.id, attachments: state.attachments, inspection: state.inspection }));
}

async function complete() {
  const jobId = option('job-id');
  const state = await readState(jobId);
  const topicLabelKey = option('topic-label-key').trim();
  const urgencyLabelKey = option('urgency-label-key').trim();
  const contactDisposition = option('contact-disposition').trim();
  const entityTypeRaw = option('entity-type', 'none').trim();
  const roleKeyRaw = option('role-key', 'none').trim();
  const confidence = Number.parseFloat(option('confidence'));
  const displayName = boundedDisplayName(state);
  const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  if (!slug.test(topicLabelKey) || !slug.test(urgencyLabelKey)) throw new Error('label key is invalid');
  const enabledTopics = new Set((state.topicLabels || []).map((label) => label?.key).filter(Boolean));
  const enabledUrgencies = new Set((state.urgencyLabels || []).map((label) => label?.key).filter(Boolean));
  const enabledRoles = new Set((state.roleDefinitions || []).map((role) => role?.key).filter(Boolean));
  if (!enabledTopics.has(topicLabelKey) || !enabledUrgencies.has(urgencyLabelKey)) throw new Error('label key is not enabled for this workspace');
  if (!new Set(['existing', 'create', 'suggest', 'ignore', 'conflict']).has(contactDisposition)) throw new Error('contact disposition is invalid');
  if (!new Set(['none', 'person', 'business']).has(entityTypeRaw)) throw new Error('entity type is invalid');
  if (roleKeyRaw !== 'none' && !enabledRoles.has(roleKeyRaw)) throw new Error('role key is not enabled for this workspace');
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('confidence must be between 0 and 1');
  if (contactDisposition === 'create' && (entityTypeRaw === 'none' || roleKeyRaw === 'none' || !displayName)) {
    throw new Error('create proposals require a provider-backed display name, entity type, and configured role');
  }
  const attachments = Array.isArray(state.attachments) ? state.attachments : [];
  const result = await request('complete', {
    jobId: state.job.id,
    leaseToken: state.job.leaseToken,
    topicLabelKey,
    urgencyLabelKey,
    contactDisposition,
    entityType: entityTypeRaw === 'none' ? null : entityTypeRaw,
    roleKey: roleKeyRaw === 'none' ? null : roleKeyRaw,
    displayName,
    confidence,
    reason: `Hermes selected topic ${topicLabelKey}, urgency ${urgencyLabelKey}, and contact disposition ${contactDisposition} from the enabled Fluid vocabulary.`,
    model: option('model', DEFAULT_MODEL),
    promptVersion: PROMPT_VERSION,
    evidence: {
      source: 'hermes',
      inputRevision: state.job.inputRevision,
      provider: state.signal.source,
      eventType: state.signal.event_type,
      direction: state.signal.direction,
      contactAlreadyResolved: Boolean(state.contact),
      identityKinds: Array.isArray(state.identities) ? state.identities.map((identity) => identity.kind) : [],
      transcriptStatus: state.transcript?.status || null,
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
    'classification-failed': 'Hermes could not complete triage for this staged signal.',
    'completion-failed': 'The bounded Fluid completion command failed.',
  };
  const error = safeErrors[errorCode];
  if (!error) throw new Error('error-code is invalid');
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
  console.log(JSON.stringify(await request('status', {}, 'GET')));
}

async function reconcile() {
  const limit = positiveInt(option('limit', '500'), 500, 5000);
  console.log(JSON.stringify(await request('reconcile', { limit })));
}

const command = process.argv[2] || '';
if (command === 'claim' || command === 'precheck') await claim();
else if (command === 'inspect') await inspect();
else if (command === 'complete') await complete();
else if (command === 'fail') await fail();
else if (command === 'status') await status();
else if (command === 'reconcile') await reconcile();
else throw new Error('usage: fluid-signal-triage.mjs claim|inspect|complete|fail|status|reconcile');
