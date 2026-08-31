#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermesRuntimeCorrelation } from '../automation-creator/runtime-correlation.mjs';

const AGENT_KEY = 'potential-lead-classifier';
const DISPLAY_NAME = 'Potential Lead Classifier — inbound email, text, call → Potential Leads';
const PROMPT_VERSION = 'fluid-potential-lead-classifier-v2';
const DEFAULT_MODEL = 'nous/openai/gpt-5.6-luna';
const DEFAULT_URL = 'https://fskrxkiujtfuxntcrjam.supabase.co/functions/v1/fluid-potential-lead-classifier';
const API_URL = (process.env.FLUID_POTENTIAL_LEAD_CLASSIFIER_URL || DEFAULT_URL).replace(/\/$/, '');
const API_SECRET = (process.env.FLUID_POTENTIAL_LEAD_CLASSIFIER_SECRET || '').trim();
const STATE_DIR = resolve(
  process.env.FLUID_POTENTIAL_LEAD_CLASSIFIER_STATE_DIR || '/opt/data/fluid/potential-lead-classifier',
);
const MODEL = process.env.FLUID_POTENTIAL_LEAD_CLASSIFIER_MODEL || DEFAULT_MODEL;
const WORKER = `hermes-potential-lead-${hostname()}`.slice(0, 100);
const GMAIL_READER = resolve(process.env.OTTAWA_GMAIL_READER || '/opt/data/bin/ottawa-gmail-read');
const GMAIL_READER_LIB_URL = process.env.OTTAWA_GMAIL_READER_LIB_URL ||
  'file:///opt/data/bin/lib/ottawa-gmail-read.mjs';
const GMAIL_TOKEN_LIB_URL = process.env.OTTAWA_GMAIL_TOKEN_LIB_URL ||
  'file:///opt/data/bin/lib/ottawa-customer-rag.mjs';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const EXTRACTABLE_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);

const LEAD_KINDS = new Set([
  'quote-request',
  'service-question',
  'booking',
  'missed-call',
  'voicemail',
  'other',
]);
const SAFE_SUMMARY = /^[A-Za-z0-9 .,:;?!()/@&+\-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function option(argv, name, fallback = '') {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
}

function positiveInt(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function oneLine(value, maximum) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function runtimeCorrelation(environment = process.env) {
  return hermesRuntimeCorrelation(environment);
}

function safeSummary(value, required) {
  const raw = String(value || '');
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new Error('summary must be one printable line');
  const summary = raw.replace(/\s+/g, ' ').trim();
  if (!summary) {
    if (required) throw new Error('a lead verdict requires --summary');
    return '';
  }
  if (summary.length > 240) throw new Error('summary must be at most 240 characters');
  if (!SAFE_SUMMARY.test(summary)) {
    throw new Error('summary contains unsupported punctuation; paraphrase it using plain text');
  }
  return summary;
}

function normalizeEmail(value) {
  const cleaned = oneLine(value, 320).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned) ? cleaned : '';
}

function normalizePhone(value) {
  const cleaned = oneLine(value, 40);
  if (!/^\+?[0-9(][0-9 ().-]{5,}$/.test(cleaned)) return '';
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : '';
}

function normalizeName(value) {
  const cleaned = oneLine(value, 80);
  return /^[\p{L}][\p{L}\p{M} .'’-]{0,79}$/u.test(cleaned) ? cleaned : '';
}

function identityValue(state, kind) {
  const identities = Array.isArray(state?.identities) ? state.identities : [];
  const match = identities.find((identity) =>
    identity?.kind === kind &&
    !identity?.ignored &&
    identity?.classification !== 'system' &&
    typeof identity?.value === 'string'
  );
  return match?.value || '';
}

function hasKnownIdentity(state) {
  return (Array.isArray(state?.identities) ? state.identities : []).some((identity) =>
    Number(identity?.activeClaimCount || 0) > 0
  );
}

function hasSystemIdentity(state) {
  return (Array.isArray(state?.identities) ? state.identities : []).some((identity) =>
    identity?.ignored || identity?.classification === 'system'
  );
}

function providerContact(state) {
  const signal = state?.signal || {};
  const eligibility = state?.eligibility?.eligible === true ? state.eligibility : {};
  const identities = Array.isArray(state?.identities) ? state.identities : [];
  const providerEmail = normalizeEmail(eligibility.email) || normalizeEmail(signal.actorEmail) ||
    normalizeEmail(identityValue(state, 'email'));
  const accountEmail = normalizeEmail(signal.accountEmail);
  const namedIdentity = identities.find((identity) =>
    !identity?.ignored && identity?.classification !== 'system' && identity?.displayName
  );
  return {
    name: normalizeName(eligibility.name) || normalizeName(signal.actorName) ||
      normalizeName(namedIdentity?.displayName),
    email: providerEmail && providerEmail !== accountEmail ? providerEmail : '',
    phone: normalizePhone(eligibility.phone) || normalizePhone(signal.actorPhone) ||
      normalizePhone(identityValue(state, 'phone')),
  };
}

function channelOf(signal) {
  if (signal?.eventType === 'call.completed') return 'call';
  return signal?.source === 'gmail' ? 'email' : 'text';
}

function buildCompletion(state, options) {
  const rawVerdict = String(options.verdict || '').trim();
  const verdict = rawVerdict === 'not-lead' ? 'not_lead' : rawVerdict;
  if (verdict !== 'lead' && verdict !== 'not_lead') {
    throw new Error('verdict must be lead or not-lead');
  }
  const confidence = Number.parseFloat(String(options.confidence || ''));
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('confidence must be between 0 and 1');
  }
  const kind = String(options.kind || '').trim();
  if (!LEAD_KINDS.has(kind)) {
    throw new Error(`lead-kind must be one of ${[...LEAD_KINDS].join(', ')}`);
  }
  if (state?.signal?.direction !== 'inbound') {
    throw new Error('the Potential Lead classifier accepts inbound signals only');
  }
  if (verdict === 'lead' && hasKnownIdentity(state)) {
    throw new Error('a signal whose identity is already claimed cannot be a Potential Lead');
  }
  if (verdict === 'lead' && hasSystemIdentity(state)) {
    throw new Error('a system or ignored identity cannot be a Potential Lead');
  }
  const contact = providerContact(state);
  if (verdict === 'lead' && !contact.email && !contact.phone) {
    throw new Error('a Potential Lead needs a provider-backed email address or phone number');
  }
  const summary = safeSummary(options.summary, verdict === 'lead');
  const channel = channelOf(state.signal);
  const identities = Array.isArray(state?.identities) ? state.identities : [];
  // Contact details the sender explicitly stated in the message content. They
  // enrich the card; the database stores them as unverified claimed_* fields
  // and never lets them key the card or satisfy the provider-backed rule above.
  const claimedName = normalizeName(options.contactName);
  const claimedEmail = normalizeEmail(options.contactEmail);
  const claimedPhone = normalizePhone(options.contactPhone);
  return {
    jobId: state.job.id,
    leaseToken: state.job.leaseToken,
    verdict,
    confidence,
    name: claimedName || contact.name || null,
    email: claimedEmail || contact.email || null,
    phone: claimedPhone || contact.phone || null,
    summary: summary || null,
    reason: verdict === 'lead'
      ? `Hermes classified this inbound ${channel} as a possible painting lead (${kind.replaceAll('-', ' ')}).`
      : `Hermes classified this inbound ${channel} as not a painting lead (${kind.replaceAll('-', ' ')}).`,
    model: options.model || MODEL,
    promptVersion: PROMPT_VERSION,
    evidence: {
      source: 'hermes',
      inputRevision: state.job.inputRevision,
      provider: state.signal.source,
      eventType: state.signal.eventType,
      direction: state.signal.direction,
      kind,
      contactFrom: claimedName || claimedEmail || claimedPhone ? 'content' : 'provider',
      claimedFields: [
        ...(claimedName ? ['name'] : []),
        ...(claimedEmail ? ['email'] : []),
        ...(claimedPhone ? ['phone'] : []),
      ],
      summaryFrom: summary ? 'agent' : null,
      identityKinds: identities.map((identity) => identity?.kind).filter(Boolean),
      transcriptStatus: state.transcript?.status || null,
      attachmentEvidenceCount: Array.isArray(state.attachments) ? state.attachments.length : 0,
      attachmentStatuses: Array.isArray(state.attachments)
        ? state.attachments.map((attachment) => attachment?.status).filter(Boolean).slice(0, 10)
        : [],
    },
  };
}

function jobPath(jobId) {
  const id = positiveInt(jobId, 0);
  if (!id) throw new Error('job id must be a positive integer');
  return resolve(STATE_DIR, `job-${id}.json`);
}

function validatedState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('staged job is invalid');
  const id = positiveInt(value.job?.id, 0);
  if (!id || !UUID.test(String(value.job?.leaseToken || '')) || !value.signal?.id) {
    throw new Error('staged job is incomplete');
  }
  return value;
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
  for (let index = 0; index < rows.length && normalized.length < 10; index += 1) {
    const item = rows[index];
    const filename = firstString(item, ['filename', 'fileName', 'name']);
    const attachmentKey = firstString(item, [
      'attachmentKey', 'attachmentId', 'attachment_id', 'partId', 'part_id', 'id',
    ]) || filename || String(index + 1);
    if (seen.has(attachmentKey)) continue;
    seen.add(attachmentKey);
    const extractedText = firstString(item, [
      'extractedText', 'extracted_text', 'ocrText', 'ocr_text', 'transcription',
      'transcript', 'text', 'textContent', 'text_content', 'content_text',
    ]).slice(0, 20_000);
    const rawSize = item.sizeBytes ?? item.size_bytes ?? item.size ?? null;
    const size = Number.parseInt(String(rawSize ?? ''), 10);
    const requestedStatus = firstString(item, [
      'status', 'extractionStatus', 'extraction_status', 'contentStatus', 'content_status',
    ]).toLowerCase();
    const status = extractedText
      ? 'extracted'
      : requestedStatus === 'no_text_found' ? 'no_text'
        : requestedStatus === 'unsupported_type' ? 'unsupported'
          : /(?:failed|timeout|invalid|http_)/.test(requestedStatus) ? 'failed'
            : requestedStatus || 'metadata';
    normalized.push({
      attachmentKey: attachmentKey.slice(0, 500),
      filename: filename.slice(0, 500) || null,
      mimeType: firstString(item, ['mimeType', 'mime_type', 'contentType', 'content_type']).slice(0, 200) || null,
      sizeBytes: Number.isSafeInteger(size) && size >= 0 ? size : null,
      status,
      extractionMethod: firstString(item, ['extractionMethod', 'extraction_method', 'method']).slice(0, 100) || null,
      extractedText: extractedText || null,
    });
  }
  return normalized;
}

function mergeAttachments(stored, inspected) {
  const merged = new Map();
  for (const attachment of Array.isArray(stored) ? stored : []) {
    if (attachment?.attachmentKey) merged.set(String(attachment.attachmentKey), attachment);
  }
  for (const attachment of Array.isArray(inspected) ? inspected : []) {
    if (!attachment?.attachmentKey) continue;
    const prior = merged.get(String(attachment.attachmentKey)) || {};
    merged.set(String(attachment.attachmentKey), { ...prior, ...attachment });
  }
  return [...merged.values()].slice(0, 10);
}

async function enrichAttachmentText(state, inspection) {
  const attachments = normalizeAttachments(inspection);
  const maximumAttachments = boundedEnvInteger('HERMES_GMAIL_MAX_ATTACHMENTS', 3, 1, 5);
  const maximumBytes = boundedEnvInteger('HERMES_GMAIL_MAX_ATTACHMENT_BYTES', 5_000_000, 64_000, 10_000_000);
  const maximumText = boundedEnvInteger('HERMES_GMAIL_MAX_ATTACHMENT_TEXT', 6_000, 500, 20_000);
  const candidates = attachments
    .filter((attachment) => !attachment.extractedText)
    .filter((attachment) => EXTRACTABLE_MIME_TYPES.has(inferredMimeType(attachment.filename, attachment.mimeType)))
    .slice(0, maximumAttachments);
  if (candidates.length === 0) return attachments;

  const [{ googleAccessToken }, { extractAttachmentText }] = await Promise.all([
    import(GMAIL_TOKEN_LIB_URL),
    import(GMAIL_READER_LIB_URL),
  ]);
  const token = await googleAccessToken(process.env, fetch);
  const messageId = String(state.signal.externalId);
  const messageResponse = await fetch(`${GMAIL_API}/messages/${encodeURIComponent(messageId)}?format=full`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  const message = await messageResponse.json().catch(() => ({}));
  if (!messageResponse.ok) throw new Error(`Gmail attachment metadata read failed with HTTP ${messageResponse.status}`);
  const rawParts = rawAttachmentParts(message.payload);

  for (const attachment of candidates) {
    const exact = rawParts.find((part) => part.filename === attachment.filename) ||
      rawParts[attachments.indexOf(attachment)];
    const mimeType = inferredMimeType(attachment.filename, exact?.mimeType || attachment.mimeType);
    attachment.mimeType = mimeType;
    if (!exact?.attachmentId) {
      attachment.status = 'failed';
      continue;
    }
    if (exact.sizeBytes !== null && exact.sizeBytes > maximumBytes) {
      attachment.status = 'unsupported';
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
      attachment.status = 'failed';
      continue;
    }
    const bytes = decodeBase64UrlBytes(content.data);
    if (bytes.length === 0 || bytes.length > maximumBytes) {
      attachment.status = bytes.length === 0 ? 'failed' : 'unsupported';
      continue;
    }
    const extracted = await extractAttachmentText({ bytes, mimeType, maximumText });
    attachment.status = extracted.text ? 'extracted' : extracted.status || 'no_text';
    attachment.extractionMethod = extracted.method || attachment.extractionMethod;
    if (extracted.text) attachment.extractedText = oneLine(extracted.text, maximumText);
  }
  return attachments;
}

async function inspectGmailAttachments(state) {
  const hasAttachments = state.signal.hasAttachments || Number(state.signal.attachmentCount || 0) > 0;
  if (state.signal.source !== 'gmail' || !state.signal.externalId || !hasAttachments) return [];
  const result = spawnSync(
    GMAIL_READER,
    ['message', '--message-id', String(state.signal.externalId), '--json'],
    {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Gmail reader failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 1000)}`,
    );
  }
  return enrichAttachmentText(state, parseReaderOutput(result.stdout));
}

async function writeState(value) {
  const state = validatedState(value);
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const target = jobPath(state.job.id);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}

async function readState(jobId) {
  return validatedState(JSON.parse(await readFile(jobPath(jobId), 'utf8')));
}

async function request(action, body, method = 'POST') {
  if (API_SECRET.length < 43) {
    throw new Error('Fluid Potential Lead classifier authorization is not configured');
  }
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
    throw new Error(`Fluid Potential Lead classifier API: ${detail}`);
  }
  return payload;
}

async function claim(argv) {
  const limit = positiveInt(option(argv, 'limit', '5'), 5, 5);
  const payload = await request('claim', { worker: WORKER, limit, leaseSeconds: 900 });
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  for (const staged of jobs) await writeState(staged);
  process.stdout.write(JSON.stringify({
    wakeAgent: jobs.length > 0,
    agentKey: payload?.agentKey || AGENT_KEY,
    displayName: DISPLAY_NAME,
    promptVersion: PROMPT_VERSION,
    jobs,
  }));
}

async function inspect(argv) {
  const jobId = option(argv, 'job-id');
  const state = await readState(jobId);
  const payload = await request('inspect', {
    jobId: state.job.id,
    leaseToken: state.job.leaseToken,
  });
  const refreshed = validatedState(payload?.item);
  if (refreshed.job.id !== state.job.id || refreshed.job.leaseToken !== state.job.leaseToken) {
    throw new Error('inspection returned a different job lease');
  }
  const inspectedAttachments = await inspectGmailAttachments(refreshed);
  refreshed.attachments = mergeAttachments(refreshed.attachments, inspectedAttachments);
  await writeState(refreshed);
  process.stdout.write(JSON.stringify({ agentKey: payload?.agentKey || AGENT_KEY, item: refreshed }));
}

async function complete(argv) {
  const jobId = option(argv, 'job-id');
  const state = await readState(jobId);
  const completion = buildCompletion(state, {
    verdict: option(argv, 'verdict'),
    confidence: option(argv, 'confidence'),
    kind: option(argv, 'lead-kind'),
    summary: option(argv, 'summary'),
    contactName: option(argv, 'contact-name'),
    contactEmail: option(argv, 'contact-email'),
    contactPhone: option(argv, 'contact-phone'),
    model: MODEL,
  });
  Object.assign(completion, runtimeCorrelation());
  const payload = await request('complete', completion);
  await unlink(jobPath(jobId)).catch(() => undefined);
  process.stdout.write(JSON.stringify(payload));
}

async function fail(argv) {
  const jobId = option(argv, 'job-id');
  const state = await readState(jobId);
  const code = option(argv, 'error-code', 'classification-failed');
  const safeErrors = {
    'classification-failed': 'Hermes could not classify this staged signal.',
    'context-insufficient': 'The staged signal did not contain enough evidence to classify.',
    'inspection-failed': 'The bounded classifier inspection failed.',
    'completion-failed': 'The bounded classifier completion failed.',
  };
  if (!safeErrors[code]) throw new Error('error-code is invalid');
  const payload = await request('fail', {
    jobId: state.job.id,
    leaseToken: state.job.leaseToken,
    error: safeErrors[code],
    model: MODEL,
    promptVersion: PROMPT_VERSION,
    ...runtimeCorrelation(),
  });
  await unlink(jobPath(jobId)).catch(() => undefined);
  process.stdout.write(JSON.stringify(payload));
}

async function status() {
  process.stdout.write(JSON.stringify(await request('status', {}, 'GET')));
}

async function reconcile(argv) {
  const limit = positiveInt(option(argv, 'limit', '500'), 500, 5000);
  process.stdout.write(JSON.stringify(await request('reconcile', { limit })));
}

async function main(argv) {
  const command = argv[0] || '';
  if (command === 'claim' || command === 'precheck') await claim(argv);
  else if (command === 'inspect') await inspect(argv);
  else if (command === 'complete') await complete(argv);
  else if (command === 'fail') await fail(argv);
  else if (command === 'status') await status();
  else if (command === 'reconcile') await reconcile(argv);
  else throw new Error(
    'usage: fluid-potential-lead-classifier.mjs claim|inspect|complete|fail|status|reconcile',
  );
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export {
  AGENT_KEY,
  buildCompletion,
  DISPLAY_NAME,
  hasKnownIdentity,
  hasSystemIdentity,
  normalizeEmail,
  mergeAttachments,
  normalizePhone,
  PROMPT_VERSION,
  providerContact,
  runtimeCorrelation,
  safeSummary,
};
