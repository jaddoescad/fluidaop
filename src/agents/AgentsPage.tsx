import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SideNav } from '../components/AppChrome';
import {
  HermesAgentDefinition,
  HermesAgentHistory,
  HermesRun,
  HermesRunStatus,
  HermesSkill,
  HermesStatus,
  changeHermesAgent,
  loadHermesAgents,
  loadHermesHistory,
  loadHermesSkills,
  loadHermesStatus,
} from './hermes';
import '../variants/flow.css';
import '../variants/zen.css';
import './agents.css';

const AGENTS_PATH = '/agents';

function agentIdFromPath(): string | null {
  const match = /^\/agents\/([A-Za-z0-9_.-]{1,128})$/.exec(window.location.pathname);
  return match === null ? null : match[1];
}

export function AgentsPage({
  onNavigate,
  header,
}: {
  onNavigate: (label: string) => void;
  header: ReactNode;
}) {
  const [status, setStatus] = useState<HermesStatus | null>(null);
  const [agents, setAgents] = useState<HermesAgentDefinition[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(agentIdFromPath);
  const [history, setHistory] = useState<HermesAgentHistory | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyReload, setHistoryReload] = useState(0);
  const [skills, setSkills] = useState<HermesSkill[] | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextAgents] = await Promise.all([loadHermesStatus(), loadHermesAgents()]);
      setStatus(nextStatus);
      setAgents(nextAgents);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not reach Hermes');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Skill descriptions turn the bare skill names on an agent into something readable.
  useEffect(() => {
    loadHermesSkills().then(setSkills).catch(() => setSkills([]));
  }, []);

  const select = useCallback((agentId: string | null) => {
    const path = agentId === null ? AGENTS_PATH : `${AGENTS_PATH}/${agentId}`;
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    setActionError(null);
    setSelectedId(agentId);
  }, []);

  // List and detail share one scroll container, so a deep dive would otherwise
  // open halfway down the page.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [selectedId]);

  useEffect(() => {
    const syncFromPath = () => setSelectedId(agentIdFromPath());
    window.addEventListener('popstate', syncFromPath);
    return () => window.removeEventListener('popstate', syncFromPath);
  }, []);

  useEffect(() => {
    if (selectedId === null) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') select(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [select, selectedId]);

  useEffect(() => {
    if (selectedId === null) {
      setHistory(null);
      setHistoryError(null);
      setHistoryLoading(false);
      return;
    }

    const controller = new AbortController();
    const selectedAgent = agents?.find((agent) => agent.id === selectedId);
    if (selectedAgent === undefined) return;
    setHistory(null);
    setHistoryError(null);
    setHistoryLoading(true);
    void loadHermesHistory(
      selectedAgent.historyAgentId ?? selectedAgent.id,
      controller.signal,
      selectedAgent.historyAgentId === null ? selectedAgent.id : undefined,
    )
      .then((nextHistory) => {
        setHistory(nextHistory);
        setHistoryError(null);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setHistoryError(reason instanceof Error ? reason.message : 'Could not load Hermes history');
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false);
      });

    return () => controller.abort();
  }, [agents, historyReload, selectedId]);

  const online = status?.connected === true;
  const selectedAgent = agents?.find((agent) => agent.id === selectedId) ?? null;

  const toggleEnabled = useCallback(async (agent: HermesAgentDefinition) => {
    setPending(true);
    setActionError(null);
    try {
      await changeHermesAgent(agent, agent.enabled ? 'pause' : 'resume');
      await refresh();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Could not update this agent');
    } finally {
      setPending(false);
    }
  }, [refresh]);

  if (selectedId !== null) {
    return (
      <div className="v v-flow v-zen ag-root">
        <div className="fl-shell">
          <SideNav active="Agents" onNav={onNavigate} />
          <div className="fl-frame">
            {header}
            <main className="ag-main" ref={mainRef}>
              <div className="ag-inner">
                <button type="button" className="ag-back" onClick={() => select(null)}>
                  ‹ All agents
                </button>
                {selectedAgent === null ? (
                  <div className="ag-history-empty" role="status">
                    <strong>{agents === null ? 'Loading agent' : 'Agent not found'}</strong>
                    <p>
                      {agents === null
                        ? 'Reading the live Hermes agent roster…'
                        : `Hermes is not reporting an agent-mode job with the id “${selectedId}”.`}
                    </p>
                  </div>
                ) : (
                  <AgentDetail
                    agent={selectedAgent}
                    status={status}
                    skills={skills}
                    history={history}
                    historyError={historyError}
                    historyLoading={historyLoading}
                    onReloadHistory={() => setHistoryReload((value) => value + 1)}
                    onToggleEnabled={() => void toggleEnabled(selectedAgent)}
                    pending={pending}
                    actionError={actionError}
                  />
                )}
              </div>
            </main>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="v v-flow v-zen ag-root">
      <div className="fl-shell">
        <SideNav active="Agents" onNav={onNavigate} />
        <div className="fl-frame">
          {header}
          <main className="ag-main" ref={mainRef}>
            <div className="ag-inner">
              <header className="ag-head">
                <div>
                  <h1>Agents</h1>
                  <p>Your Ottawa Painters AI workers — the Hermes jobs that reason with a model. Timing and script jobs live in Schedules.</p>
                </div>
                <button type="button" className="ag-refresh" onClick={() => void refresh()}>
                  Refresh
                </button>
              </header>

              <section className={`ag-runtime${error !== null ? ' ag-runtime-error' : ''}`} aria-live="polite">
                <span className={`ag-dot${online ? ' ag-dot-online' : ''}`} />
                <div className="ag-runtime-copy">
                  <strong>{error !== null ? 'Hermes unavailable' : status === null ? 'Checking Hermes' : online ? 'Hermes online' : 'Hermes offline'}</strong>
                  <span>
                    {error !== null
                      ? error
                      : status === null
                        ? 'Connecting to the agent gateway…'
                        : `v${status.version ?? 'unknown'} · ${status.profiles.length} profiles · ${agents?.length ?? 0} agents · ${status.activeAgents} active now`}
                  </span>
                </div>
              </section>

              {error !== null ? (
                <div className="ag-history-empty ag-history-error" role="alert">
                  <strong>Agents unavailable</strong>
                  <p>{error}</p>
                  <button type="button" onClick={() => void refresh()}>Try again</button>
                </div>
              ) : agents === null ? (
                <div className="ag-history-empty" role="status">
                  <strong>Loading agents</strong>
                  <p>Reading the live Hermes agent roster…</p>
                </div>
              ) : agents.length === 0 ? (
                <div className="ag-history-empty">
                  <strong>No Hermes agents</strong>
                  <p>Hermes is online, but it is not reporting any agent-mode jobs. Script-only jobs appear under Schedules.</p>
                </div>
              ) : (
              <div className="ag-list" aria-label="Hermes agents">
                {agents.map((agent) => {
                  const state = agentState(agent, status);
                  return (
                    <button
                      type="button"
                      className="ag-row"
                      key={agent.id}
                      onClick={() => select(agent.id)}
                    >
                      <span className="ag-icon" aria-hidden="true">{agent.icon}</span>
                      <span className="ag-row-copy">
                        <strong>{agent.name}</strong>
                        <span>{agent.description}</span>
                        <span className="ag-row-timing">
                          {agent.lastRunAt === null
                            ? 'Never run'
                            : `Last run ${formatRelative(agent.lastRunAt)}`}
                          {agent.nextRunAt !== null && agent.enabled
                            ? ` · Next ${formatRelative(agent.nextRunAt)}`
                            : ''}
                        </span>
                      </span>
                      <span className="ag-row-meta">
                        <span>{agent.schedule}</span>
                        <span className={`ag-status ag-status-${state.tone}`}>
                          {status === null ? 'Checking' : state.label}
                        </span>
                      </span>
                      <span className="ag-chevron" aria-hidden="true">›</span>
                    </button>
                  );
                })}
              </div>
              )}

              <p className="ag-note">
                This list comes directly from Hermes and shows only agent-mode jobs — AI workers that reason on each run. New agents appear here without a Fluid code change; script jobs and all timing live in Schedules.
              </p>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

type AgentTone = 'connected' | 'paused' | 'attention' | 'unavailable';

function agentState(
  agent: HermesAgentDefinition,
  status: HermesStatus | null,
): { label: string; tone: AgentTone } {
  const profileAvailable = status?.connected === true && status.profiles.includes(agent.profile);
  if (!profileAvailable) return { label: 'Unavailable', tone: 'unavailable' };
  if (!agent.enabled) return { label: 'Paused', tone: 'paused' };
  if (agent.lastError !== null) return { label: 'Needs attention', tone: 'attention' };
  return { label: 'Connected', tone: 'connected' };
}

function AgentDetail({
  agent,
  status,
  skills,
  history,
  historyError,
  historyLoading,
  onReloadHistory,
  onToggleEnabled,
  pending,
  actionError,
}: {
  agent: HermesAgentDefinition;
  status: HermesStatus | null;
  skills: HermesSkill[] | null;
  history: HermesAgentHistory | null;
  historyError: string | null;
  historyLoading: boolean;
  onReloadHistory: () => void;
  onToggleEnabled: () => void;
  pending: boolean;
  actionError: string | null;
}) {
  const state = agentState(agent, status);
  const definition = agent.definition;
  const profiles = history?.jobs.length
    ? Array.from(new Set(history.jobs.map((job) => job.profile))).join(', ')
    : agent.profile;
  // Hermes reports the cron job's own last-run fields only for some jobs; the
  // newest execution record covers the rest.
  const lastRun = history?.runs[0] ?? null;

  const skillDetails = useMemo(() => {
    const names = definition?.skills ?? [];
    return names.map((name) => ({
      name,
      description: skills?.find((skill) => skill.id === name || skill.name === name)?.description ?? null,
    }));
  }, [definition, skills]);

  return (
    <>
      <header className="ag-detail-head">
        <span className="ag-inspector-icon" aria-hidden="true">{agent.icon}</span>
        <div className="ag-detail-title">
          <span className="ag-eyebrow">Hermes agent · {agent.runtimeName}</span>
          <h1>{agent.name}</h1>
          <p>{agent.description}</p>
        </div>
        <div className="ag-detail-actions">
          <span className={`ag-status ag-status-${state.tone}`}>{state.label}</span>
          <button
            type="button"
            className="ag-refresh"
            onClick={onToggleEnabled}
            disabled={pending || state.tone === 'unavailable'}
          >
            {pending ? 'Working…' : agent.enabled ? 'Pause agent' : 'Resume agent'}
          </button>
        </div>
      </header>

      {actionError !== null ? (
        <div className="ag-banner ag-banner-danger" role="alert">
          <strong>Could not change this agent</strong>
          <p>{actionError}</p>
        </div>
      ) : null}

      {agent.lastError !== null ? (
        <div className="ag-banner ag-banner-danger" role="alert">
          <strong>Last run reported an error</strong>
          <p>{agent.lastError}</p>
        </div>
      ) : null}

      {agent.contractStatus !== 'verified' ? (
        <div className="ag-banner ag-banner-warn">
          <strong>Presentation details are not verified ({agent.contractStatus})</strong>
          <p>
            The name, summary and steps above come from a contract that no longer matches the live
            Hermes definition, so trust the instructions below over them.
          </p>
        </div>
      ) : null}

      <dl className="ag-facts ag-facts-wide">
        <div><dt>Schedule</dt><dd>{agent.schedule}</dd></div>
        <div><dt>Next run</dt><dd>{agent.enabled ? formatAbsolute(agent.nextRunAt, 'Not scheduled') : 'Paused'}</dd></div>
        <div><dt>Last run</dt><dd>{formatAbsolute(agent.lastRunAt ?? lastRun?.startedAt ?? null, 'Never run')}</dd></div>
        <div><dt>Last result</dt><dd>{agent.lastRunStatus ?? lastRun?.status ?? 'Not recorded'}</dd></div>
        <div><dt>Profile</dt><dd>{profiles}</dd></div>
        <div><dt>Model</dt><dd>{definition?.model ?? lastRun?.model ?? 'Profile default'}</dd></div>
      </dl>

      {agent.steps.length > 0 ? (
        <section className="ag-detail-section">
          <h3>How it runs</h3>
          <ol className="ag-sequence">
            {agent.steps.map((step, index) => (
              <li key={step}>
                <span>{index + 1}</span>
                <p>{step}</p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section className="ag-detail-section">
        <h3>Instructions</h3>
        {definition === null ? (
          <div className="ag-history-empty">
            <strong>Definition not exposed</strong>
            <p>
              This Hermes deployment predates definition passthrough, so Fluid cannot read the
              prompt this agent runs on. Update the fluid-history plugin on the Hermes host.
            </p>
          </div>
        ) : (
          <>
            {definition.prompt === null ? (
              <div className="ag-history-empty">
                <strong>No prompt recorded</strong>
                <p>Hermes reports no prompt for this job — it may run entirely from a script.</p>
              </div>
            ) : (
              <>
                <pre className="ag-prompt">{definition.prompt}</pre>
                {definition.promptTruncated ? (
                  <p className="ag-note">Prompt truncated for display.</p>
                ) : null}
              </>
            )}

            {skillDetails.length > 0 ? (
              <div className="ag-skills">
                <h4>Skills it can use</h4>
                {skillDetails.map((skill) => (
                  <div className="ag-skill" key={skill.name}>
                    <strong>{skill.name}</strong>
                    <span>{skill.description ?? 'No description reported by Hermes.'}</span>
                  </div>
                ))}
              </div>
            ) : null}

            <dl className="ag-facts ag-facts-wide ag-facts-quiet">
              <div><dt>Script</dt><dd>{definition.script ?? 'None'}</dd></div>
              <div><dt>Working dir</dt><dd>{definition.workdir ?? 'Default'}</dd></div>
              <div>
                <dt>Timeout</dt>
                <dd>{definition.timeoutSeconds === null ? 'Default' : `${definition.timeoutSeconds}s`}</dd>
              </div>
              <div><dt>Definition hash</dt><dd>{definition.definitionHash ?? 'Unverified'}</dd></div>
            </dl>
          </>
        )}
      </section>

      <section className="ag-detail-section">
        <div className="ag-detail-heading">
          <h3>Run history</h3>
          <button
            type="button"
            className="ag-history-refresh"
            onClick={onReloadHistory}
            disabled={historyLoading}
          >
            {historyLoading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        <RunHistory
          history={history}
          error={historyError}
          loading={historyLoading}
          onRetry={onReloadHistory}
        />
      </section>
    </>
  );
}

function RunHistory({
  history,
  error,
  loading,
  onRetry,
}: {
  history: HermesAgentHistory | null;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div className="ag-history-empty" role="status">
        <strong>Reading Hermes</strong>
        <p>Loading the cron execution ledger and matching session records…</p>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="ag-history-empty ag-history-error" role="alert">
        <strong>History unavailable</strong>
        <p>{error}</p>
        <button type="button" onClick={onRetry}>Try again</button>
      </div>
    );
  }

  if (history === null) return null;
  if (history.jobs.length === 0) {
    return (
      <div className="ag-history-empty">
        <strong>No matching Hermes job</strong>
        <p>No cron job currently matches this agent name. Rename the Hermes job or update its mapping in Fluid.</p>
      </div>
    );
  }
  if (history.runs.length === 0) {
    return (
      <div className="ag-history-empty">
        <strong>No runs recorded yet</strong>
        <p>{history.jobs.map((job) => job.name).join(', ')} is connected, but Hermes has no execution records for it yet.</p>
      </div>
    );
  }

  return (
    <ol className="ag-history-list" aria-label="Hermes run history">
      {history.runs.map((run) => <RunHistoryRow key={run.id} run={run} />)}
    </ol>
  );
}

const RUN_STATUS_LABELS: Record<HermesRunStatus, string> = {
  claimed: 'Claimed',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  unknown: 'Unknown',
  recorded: 'Recorded',
};

const RUN_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const RELATIVE_FORMATTER = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function RunHistoryRow({ run }: { run: HermesRun }) {
  const facts = [
    run.model,
    run.messageCount === null ? null : `${run.messageCount} messages`,
    run.toolCallCount === null ? null : `${run.toolCallCount} tools`,
    formatDuration(run.startedAt, run.finishedAt),
  ].filter((fact): fact is string => Boolean(fact));

  return (
    <li className="ag-history-row">
      <span className={`ag-run-dot ag-run-${run.status}`} aria-hidden="true" />
      <div className="ag-run-copy">
        <div className="ag-run-title">
          <strong>{run.jobName}</strong>
          <span className={`ag-run-status ag-run-status-${run.status}`}>
            {RUN_STATUS_LABELS[run.status]}
          </span>
        </div>
        <time dateTime={run.startedAt ?? undefined}>{formatRunTime(run.startedAt)}</time>
        {facts.length > 0 ? <p>{facts.join(' · ')}</p> : null}
        {run.error !== null ? <p className="ag-run-error">{run.error}</p> : null}
      </div>
    </li>
  );
}

function formatRunTime(value: string | null): string {
  if (value === null) return 'Time not recorded';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return RUN_DATE_FORMATTER.format(timestamp);
}

function formatAbsolute(value: string | null, fallback: string): string {
  if (value === null) return fallback;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return `${RUN_DATE_FORMATTER.format(timestamp)} (${formatRelative(value)})`;
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.35],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
];

function formatRelative(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  let delta = (timestamp - Date.now()) / 1000;
  for (const [unit, span] of RELATIVE_UNITS) {
    if (Math.abs(delta) < span) return RELATIVE_FORMATTER.format(Math.round(delta), unit);
    delta /= span;
  }
  return value;
}

function formatDuration(startedAt: string | null, finishedAt: string | null): string | null {
  if (startedAt === null || finishedAt === null) return null;
  const durationSeconds = Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(durationSeconds)) return null;
  if (durationSeconds < 60) return `${durationSeconds}s`;
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}
