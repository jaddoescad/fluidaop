#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const manifestPath = join(root, 'hermes/automations.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const errors = [];
const keyPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const keys = new Set();
const queueKeys = new Set();
const statusByKey = new Map();

if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.automations)) {
  errors.push('hermes/automations.json must use schemaVersion 1 and an automations array');
} else {
  for (const automation of manifest.automations) {
    const key = String(automation.automationKey || '');
    if (!keyPattern.test(key)) errors.push(`invalid automationKey: ${key || '<missing>'}`);
    if (keys.has(key)) errors.push(`duplicate automationKey: ${key}`);
    keys.add(key);
    statusByKey.set(key, automation.status);
    if (!['agent', 'script'].includes(automation.mode)) errors.push(`${key}: invalid mode`);
    if (!['active', 'defined', 'retired'].includes(automation.status)) errors.push(`${key}: invalid status`);
    if (!Array.isArray(automation.subjectTypes) || automation.subjectTypes.some((type) => type !== 'signal')) {
      errors.push(`${key}: unsupported subjectTypes`);
    }
    const packagePath = resolve(root, String(automation.package || ''));
    if (!existsSync(packagePath)) errors.push(`${key}: package does not exist: ${automation.package}`);
    if (automation.status === 'active') {
      const entrypoint = resolve(root, String(automation.entrypoint || ''));
      if (!automation.entrypoint || !existsSync(entrypoint)) {
        errors.push(`${key}: active automation entrypoint does not exist: ${automation.entrypoint || '<missing>'}`);
      }
      if (!automation.schedule || automation.schedule === 'not-installed') {
        errors.push(`${key}: active automation needs a Hermes schedule`);
      }
    }
    if (automation.queueAgentKey !== null) {
      if (automation.status !== 'active') {
        errors.push(`${key}: only active automations may own a live queue`);
      }
      if (automation.mode !== 'agent' || automation.queueAgentKey !== key) {
        errors.push(`${key}: queueAgentKey must equal the agent automationKey`);
      }
      queueKeys.add(automation.queueAgentKey);
    }
  }
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'skills-archive' || entry.name === 'agents-archive') return [];
      return walk(path);
    }
    return [path];
  });
}

for (const path of walk(join(root, 'hermes'))) {
  if (path.endsWith('/crontab.example')) errors.push(`host crontab is prohibited: ${path.slice(root.length + 1)}`);
}

for (const base of ['supabase', 'server']) {
  for (const path of walk(join(root, base))) {
    if (!statSync(path).isFile() || !/\.(sql|ts|js|mjs)$/.test(path)) continue;
    const source = readFileSync(path, 'utf8');
    if (/\b(?:cron\.schedule|pg_cron)\b/i.test(source)) {
      errors.push(`Supabase cron is prohibited: ${path.slice(root.length + 1)}`);
    }
  }
}

const serverSource = readFileSync(join(root, 'server/index.ts'), 'utf8');
if (/\bsetInterval\s*\(/.test(serverSource)) {
  errors.push('application business timers are prohibited in server/index.ts; register a Hermes script');
}

for (const base of ['hermes', 'supabase/functions']) {
  for (const path of walk(join(root, base))) {
    if (!statSync(path).isFile() || !/\.(ts|js|mjs)$/.test(path)) continue;
    if (path.includes('/skills-archive/') || path.includes('/agents-archive/')) continue;
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/(?:AGENT_KEY|agentKey)\s*=\s*['"]([a-z0-9-]+)['"]/g)) {
      const key = match[1];
      if (!keys.has(key)) errors.push(`unknown queue/runtime automation key ${key}: ${path.slice(root.length + 1)}`);
      if (statusByKey.get(key) === 'retired') {
        errors.push(`retired automation still has a runtime producer: ${key}: ${path.slice(root.length + 1)}`);
      }
    }
  }
}

for (const retired of [...statusByKey].filter(([, status]) => status === 'retired').map(([key]) => key)) {
  const livePaths = [
    join(root, `hermes/fluid-${retired}`),
    join(root, `supabase/functions/fluid-${retired}`),
  ];
  for (const path of livePaths) {
    if (existsSync(path)) errors.push(`retired automation package still exists: ${path.slice(root.length + 1)}`);
  }
}

if (!queueKeys.has('potential-lead-classifier')) {
  errors.push('the live Potential Lead queue has no registered owner');
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`automation contract: ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`automation contract: ${keys.size} definitions verified\n`);
}
