import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const PROFILE = /^[A-Za-z0-9_-]{1,64}$/;
const JOB_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const EXECUTION_ID = /^[A-Za-z0-9_.:-]{1,256}$/;
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CRON_SESSION = /^cron_(.+)_([0-9]{8}_[0-9]{6})$/;

function profileFromEnvironment(environment) {
  const explicit = String(
    environment.HERMES_SESSION_PROFILE || environment.FLUID_HERMES_PROFILE || '',
  ).trim();
  if (explicit) return explicit;

  const home = String(environment.HERMES_HOME || '').trim().replace(/\\/g, '/');
  const match = home.match(/\/profiles\/([a-z0-9][a-z0-9_-]{0,63})\/?$/i);
  return match?.[1]?.toLowerCase() || 'default';
}

export function cronJobIdFromSession(sessionId) {
  const match = String(sessionId || '').match(CRON_SESSION);
  const jobId = match?.[1] || '';
  if (!JOB_ID.test(jobId)) throw new Error('Hermes cron job identity is unavailable');
  return jobId;
}

function queryRunningExecution({ environment, hermesHome, jobId }) {
  const python = String(environment.FLUID_HERMES_PYTHON || 'python3').trim();
  const database = resolve(hermesHome, 'cron', 'executions.db');
  const source = [
    'import json, sqlite3, sys',
    'db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True, timeout=5)',
    'rows = db.execute("select id from executions where job_id = ? and status = \'running\' order by started_at desc, id desc limit 2", (sys.argv[2],)).fetchall()',
    'db.close()',
    'print(json.dumps([row[0] for row in rows]))',
  ].join('\n');
  const result = spawnSync(python, ['-c', source, database, jobId], {
    encoding: 'utf8',
    env: environment,
    timeout: 7_000,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error('Hermes execution ledger is unavailable');
  let rows;
  try {
    rows = JSON.parse(result.stdout);
  } catch {
    throw new Error('Hermes execution ledger returned an invalid result');
  }
  if (!Array.isArray(rows) || rows.length !== 1 || !EXECUTION_ID.test(String(rows[0] || ''))) {
    throw new Error('Hermes execution identity is unavailable or ambiguous');
  }
  return String(rows[0]);
}

/** Capture correlation from Hermes-owned runtime state, never model text.
 *
 * Hermes exports the exact session to tool subprocesses. Its durable cron
 * ledger contains one running row for that same cron job while the tool is
 * executing. Refuse to complete when either identity is missing or ambiguous.
 */
export function hermesRuntimeCorrelation(
  environment = process.env,
  executionLookup = queryRunningExecution,
) {
  const runtimeProfile = profileFromEnvironment(environment);
  const runtimeSessionId = String(environment.HERMES_SESSION_ID || '').trim();
  const hermesHome = String(environment.HERMES_HOME || '').trim();
  if (!PROFILE.test(runtimeProfile) || !SESSION_ID.test(runtimeSessionId) || !hermesHome) {
    throw new Error('Hermes runtime correlation is unavailable');
  }
  const runtimeJobId = cronJobIdFromSession(runtimeSessionId);
  const runtimeExecutionId = String(
    environment.HERMES_CRON_EXECUTION_ID ||
      executionLookup({ environment, hermesHome, jobId: runtimeJobId }),
  ).trim();

  if (!EXECUTION_ID.test(runtimeExecutionId)) {
    throw new Error('Hermes runtime correlation is unavailable');
  }
  return { runtimeProfile, runtimeJobId, runtimeExecutionId, runtimeSessionId };
}
