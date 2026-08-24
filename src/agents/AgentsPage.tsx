import { useCallback, useEffect, useState } from 'react';
import { Derived } from '../variants/shared';
import { SideNav } from '../variants/kit';
import {
  HERMES_AGENTS,
  HermesAgentHistory,
  HermesRun,
  HermesRunStatus,
  HermesStatus,
  loadHermesHistory,
  loadHermesStatus,
} from './hermes';
import '../variants/flow.css';
import '../variants/zen.css';
import './agents.css';

export function AgentsPage({
  d,
  onNavigate,
}: {
  d: Derived;
  onNavigate: (label: string) => void;
}) {
  const [status, setStatus] = useState<HermesStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<HermesAgentHistory | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyReload, setHistoryReload] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setStatus(await loadHermesStatus());
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

  useEffect(() => {
    if (selectedId === null) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [selectedId]);

  useEffect(() => {
    if (selectedId === null) {
      setHistory(null);
      setHistoryError(null);
      setHistoryLoading(false);
      return;
    }

    const controller = new AbortController();
    setHistory(null);
    setHistoryError(null);
    setHistoryLoading(true);
    void loadHermesHistory(selectedId, controller.signal)
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
  }, [historyReload, selectedId]);

  const online = status?.connected === true;
  const selectedAgent = HERMES_AGENTS.find((agent) => agent.id === selectedId) ?? null;
  const selectedProfiles = history?.jobs.length
    ? Array.from(new Set(history.jobs.map((job) => job.profile))).join(', ')
    : selectedAgent?.profile;

  return (
    <div className="v v-flow v-zen ag-root">
      <div className="fl-shell">
        <SideNav d={d} active="Agents" onNav={onNavigate} />
        <div className="fl-frame">
          <main className="ag-main">
            <div className="ag-inner">
              <header className="ag-head">
                <div>
                  <h1>Agents</h1>
                  <p>Your Ottawa Painters automations, connected through Hermes.</p>
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
                        : `v${status.version ?? 'unknown'} · ${status.profiles.length} profiles · ${status.activeAgents} active now`}
                  </span>
                </div>
              </section>

              <div className="ag-list" aria-label="Hermes agents">
                {HERMES_AGENTS.map((agent) => {
                  const connected = online && status.profiles.includes(agent.profile);
                  return (
                    <button
                      type="button"
                      className="ag-row"
                      key={agent.id}
                      onClick={() => setSelectedId(agent.id)}
                      aria-haspopup="dialog"
                    >
                      <span className="ag-icon" aria-hidden="true">{agent.icon}</span>
                      <span className="ag-row-copy">
                        <strong>{agent.name}</strong>
                        <span>{agent.description}</span>
                      </span>
                      <span className="ag-row-meta">
                        <span>{agent.schedule}</span>
                        <span className={`ag-status${connected ? ' ag-status-connected' : ''}`}>
                          {connected ? 'Connected' : status === null ? 'Checking' : 'Unavailable'}
                        </span>
                      </span>
                      <span className="ag-chevron" aria-hidden="true">›</span>
                    </button>
                  );
                })}
              </div>

              <p className="ag-note">
                Fluid reads gateway availability here. Skills, schedules, and safety controls remain managed by Hermes.
              </p>
            </div>
          </main>
        </div>
      </div>

      {selectedAgent !== null ? (
        <div className="ag-overlay" onMouseDown={() => setSelectedId(null)}>
          <section
            className="ag-inspector"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ag-inspector-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="ag-inspector-head">
              <span className="ag-inspector-icon" aria-hidden="true">{selectedAgent.icon}</span>
              <div>
                <span className="ag-eyebrow">Hermes agent</span>
                <h2 id="ag-inspector-title">{selectedAgent.name}</h2>
              </div>
              <button
                type="button"
                className="ag-close"
                onClick={() => setSelectedId(null)}
                aria-label="Close agent details"
                autoFocus
              >
                ×
              </button>
            </header>

            <p className="ag-inspector-description">{selectedAgent.description}</p>

            <dl className="ag-facts">
              <div><dt>Schedule</dt><dd>{selectedAgent.schedule}</dd></div>
              <div><dt>Profile</dt><dd>{selectedProfiles}</dd></div>
              <div><dt>Mode</dt><dd>{selectedAgent.mode}</dd></div>
            </dl>

            <section className="ag-detail-section">
              <h3>How it runs</h3>
              <ol className="ag-sequence">
                {selectedAgent.steps.map((step, index) => (
                  <li key={step}>
                    <span>{index + 1}</span>
                    <p>{step}</p>
                  </li>
                ))}
              </ol>
            </section>

            <section className="ag-detail-section">
              <div className="ag-detail-heading">
                <h3>Run history</h3>
                <button
                  type="button"
                  className="ag-history-refresh"
                  onClick={() => setHistoryReload((value) => value + 1)}
                  disabled={historyLoading}
                >
                  {historyLoading ? 'Loading…' : 'Refresh'}
                </button>
              </div>
              <RunHistory
                history={history}
                error={historyError}
                loading={historyLoading}
                onRetry={() => setHistoryReload((value) => value + 1)}
              />
            </section>
          </section>
        </div>
      ) : null}
    </div>
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

function formatDuration(startedAt: string | null, finishedAt: string | null): string | null {
  if (startedAt === null || finishedAt === null) return null;
  const durationSeconds = Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(durationSeconds)) return null;
  if (durationSeconds < 60) return `${durationSeconds}s`;
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}
