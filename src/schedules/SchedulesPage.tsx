import { ReactNode, useEffect, useState } from 'react';
import { SideNav } from '../components/AppChrome';
import {
  HermesAgentDefinition,
  HermesAgentHistory,
  HermesRun,
  HermesRunStatus,
  HermesStatus,
  loadHermesHistory,
} from '../agents/hermes';
import '../variants/flow.css';
import '../variants/zen.css';
import './schedules.css';

type ScheduleFilter = 'all' | 'agent' | 'script';

const FILTERS: { id: ScheduleFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'agent', label: 'Agents' },
  { id: 'script', label: 'Scripts' },
];

export function SchedulesPage({
  onNavigate,
  header,
  status,
  schedules,
  error,
  onRefresh,
}: {
  onNavigate: (label: string) => void;
  header: ReactNode;
  status: HermesStatus | null;
  schedules: HermesAgentDefinition[] | null;
  error: string | null;
  onRefresh: () => Promise<void>;
}) {
  const [filter, setFilter] = useState<ScheduleFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<HermesAgentHistory | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyReload, setHistoryReload] = useState(0);

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
    const selected = schedules?.find((schedule) => schedule.id === selectedId);
    if (selected === undefined) return;
    setHistory(null);
    setHistoryError(null);
    setHistoryLoading(true);
    void loadHermesHistory(selected.id, controller.signal, selected.id)
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
  }, [historyReload, schedules, selectedId]);

  const online = error === null && status?.connected === true;
  const degraded = error !== null && status?.gatewayState === 'running';
  const selected = schedules?.find((schedule) => schedule.id === selectedId) ?? null;
  const visible = schedules?.filter(
    (schedule) => filter === 'all' || schedule.runtimeMode === filter,
  ) ?? null;
  const agentCount = schedules?.filter((schedule) => schedule.runtimeMode === 'agent').length ?? 0;
  const scriptCount = schedules === null ? 0 : schedules.length - agentCount;
  const runtimeLabel = error !== null
    ? degraded ? 'Hermes degraded' : 'Hermes unavailable'
    : status === null
      ? 'Checking Hermes'
      : online
        ? 'Hermes online'
        : 'Hermes offline';

  return (
    <div className="v v-flow v-zen sc-root">
      <div className="fl-shell">
        <SideNav active="Schedules" onNav={onNavigate} />
        <div className="fl-frame">
          {header}
          <main className="sc-main">
            <div className="sc-inner">
              <header className="sc-head">
                <div>
                  <h1>Schedules</h1>
                  <p>
                    Schedules decide when things run. Agent jobs hand the work to an AI worker;
                    script jobs run fixed code on the same clock.
                  </p>
                </div>
                <button type="button" className="sc-refresh" onClick={() => void onRefresh()}>
                  Refresh
                </button>
              </header>

              <section className={`sc-runtime${error !== null ? ' sc-runtime-error' : ''}`} aria-live="polite">
                <span className={`sc-dot${online ? ' sc-dot-online' : degraded ? ' sc-dot-degraded' : ''}`} />
                <div className="sc-runtime-copy">
                  <strong>{runtimeLabel}</strong>
                  <span>
                    {error !== null
                      ? error
                      : status === null
                        ? 'Connecting to the scheduler…'
                        : `v${status.version ?? 'unknown'} · ${schedules?.length ?? 0} schedules · ${agentCount} agent · ${scriptCount} script`}
                  </span>
                </div>
              </section>

              <div className="sc-filter" role="group" aria-label="Filter schedules by type">
                {FILTERS.map(({ id, label }) => (
                  <button
                    key={id}
                    type="button"
                    className={`sc-filter-btn${filter === id ? ' sc-filter-active' : ''}`}
                    aria-pressed={filter === id}
                    onClick={() => setFilter(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {error !== null ? (
                <div className="sc-empty sc-empty-error" role="alert">
                  <strong>Schedules unavailable</strong>
                  <p>{error}</p>
                  <button type="button" onClick={() => void onRefresh()}>Try again</button>
                </div>
              ) : schedules === null ? (
                <div className="sc-empty" role="status">
                  <strong>Loading schedules</strong>
                  <p>Reading the live Hermes cron roster…</p>
                </div>
              ) : schedules.length === 0 ? (
                <div className="sc-empty">
                  <strong>No schedules</strong>
                  <p>Hermes is online, but it is not reporting any cron jobs.</p>
                </div>
              ) : visible !== null && visible.length === 0 ? (
                <div className="sc-empty">
                  <strong>No {filter === 'agent' ? 'agent' : 'script'} schedules</strong>
                  <p>None of the {schedules.length} Hermes schedules run in {filter} mode.</p>
                </div>
              ) : (
                <div className="sc-list" aria-label="Hermes schedules">
                  {visible?.map((schedule) => {
                    const stateLabel = !schedule.enabled
                      ? 'Paused'
                      : schedule.lastError !== null
                        ? 'Needs attention'
                        : 'Active';
                    const stateClass = !schedule.enabled
                      ? ' sc-state-paused'
                      : schedule.lastError !== null
                        ? ' sc-state-attention'
                        : ' sc-state-active';
                    return (
                      <button
                        type="button"
                        className={`sc-row${schedule.enabled ? '' : ' sc-row-paused'}`}
                        key={schedule.id}
                        onClick={() => setSelectedId(schedule.id)}
                        aria-haspopup="dialog"
                      >
                        <span className={`sc-badge sc-badge-${schedule.runtimeMode}`}>
                          {schedule.runtimeMode === 'agent' ? 'Agent' : 'Script'}
                        </span>
                        <span className="sc-row-copy">
                          <strong>{schedule.name}</strong>
                          <span>{schedule.schedule}</span>
                        </span>
                        <span className="sc-row-meta">
                          <span className="sc-next">{formatNextRun(schedule)}</span>
                          <span className={`sc-state${stateClass}`}>{stateLabel}</span>
                        </span>
                        <span className="sc-chevron" aria-hidden="true">›</span>
                      </button>
                    );
                  })}
                </div>
              )}

              <p className="sc-note">
                This roster comes directly from the Hermes scheduler — every cron job, agent-mode and
                script-mode alike. Pausing or editing a schedule happens in Hermes, not here.
              </p>
            </div>
          </main>
        </div>
      </div>

      {selected !== null ? (
        <div className="sc-scrim" onMouseDown={() => setSelectedId(null)}>
          <section
            className="sc-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sc-drawer-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="sc-drawer-head">
              <div>
                <span className="sc-eyebrow">
                  {selected.runtimeMode === 'agent' ? 'Agent schedule' : 'Script schedule'}
                </span>
                <h2 id="sc-drawer-title">{selected.name}</h2>
              </div>
              <button
                type="button"
                className="sc-close"
                onClick={() => setSelectedId(null)}
                aria-label="Close schedule details"
                autoFocus
              >
                ×
              </button>
            </header>

            <dl className="sc-facts">
              <div><dt>Runtime name</dt><dd>{selected.runtimeName}</dd></div>
              <div><dt>Profile</dt><dd>{selected.profile}</dd></div>
              <div><dt>Schedule</dt><dd>{selected.schedule}</dd></div>
              <div>
                <dt>Type</dt>
                <dd>{selected.runtimeMode === 'agent' ? 'Agent — runs with an AI worker' : 'Script — runs fixed code'}</dd>
              </div>
              <div><dt>State</dt><dd>{selected.enabled ? selected.state || 'Active' : 'Paused'}</dd></div>
              <div><dt>Next run</dt><dd>{selected.enabled ? formatStamp(selected.nextRunAt, 'Not scheduled') : 'Paused — no next run'}</dd></div>
              <div><dt>Last run</dt><dd>{formatStamp(selected.lastRunAt, 'Never ran')}</dd></div>
              <div><dt>Last status</dt><dd>{selected.lastRunStatus ?? 'Not recorded'}</dd></div>
              {selected.lastError !== null ? (
                <div className="sc-fact-error"><dt>Last error</dt><dd>{selected.lastError}</dd></div>
              ) : null}
            </dl>

            <section className="sc-drawer-section">
              <div className="sc-drawer-heading">
                <h3>Run history</h3>
                <button
                  type="button"
                  className="sc-history-refresh"
                  onClick={() => setHistoryReload((value) => value + 1)}
                  disabled={historyLoading}
                >
                  {historyLoading ? 'Loading…' : 'Refresh'}
                </button>
              </div>
              <ScheduleHistory
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

function ScheduleHistory({
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
      <div className="sc-empty" role="status">
        <strong>Reading Hermes</strong>
        <p>Loading the execution ledger for this schedule…</p>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="sc-empty sc-empty-error" role="alert">
        <strong>History unavailable</strong>
        <p>{error}</p>
        <button type="button" onClick={onRetry}>Try again</button>
      </div>
    );
  }

  if (history === null) return null;
  if (history.runs.length === 0) {
    return (
      <div className="sc-empty">
        <strong>No runs recorded yet</strong>
        <p>Hermes has no execution records for this schedule.</p>
      </div>
    );
  }

  return (
    <ol className="sc-runs" aria-label="Schedule run history">
      {history.runs.map((run) => <ScheduleRunRow key={run.id} run={run} />)}
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

function ScheduleRunRow({ run }: { run: HermesRun }) {
  const duration = formatDuration(run.startedAt, run.finishedAt);
  return (
    <li className="sc-run">
      <span className={`sc-run-dot sc-run-dot-${run.status}`} aria-hidden="true" />
      <div className="sc-run-copy">
        <div className="sc-run-top">
          <time dateTime={run.startedAt ?? undefined}>{formatStamp(run.startedAt, 'Time not recorded')}</time>
          <span className={`sc-run-status sc-run-status-${run.status}`}>{RUN_STATUS_LABELS[run.status]}</span>
        </div>
        {duration !== null ? <p>{duration}</p> : null}
        {run.error !== null ? <p className="sc-run-error">{run.error}</p> : null}
      </div>
    </li>
  );
}

const STAMP_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatStamp(value: string | null, fallback: string): string {
  if (value === null) return fallback;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return STAMP_FORMATTER.format(timestamp);
}

function formatNextRun(schedule: HermesAgentDefinition): string {
  if (!schedule.enabled) return 'Paused';
  if (schedule.nextRunAt === null) return 'Not scheduled';
  const timestamp = Date.parse(schedule.nextRunAt);
  if (!Number.isFinite(timestamp)) return schedule.nextRunAt;
  const minutes = Math.round((timestamp - Date.now()) / 60_000);
  if (minutes <= 0) return 'Due now';
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 48 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `in ${hours}h` : `in ${hours}h ${rest}m`;
  }
  return `in ${Math.round(minutes / (24 * 60))}d`;
}

function formatDuration(startedAt: string | null, finishedAt: string | null): string | null {
  if (startedAt === null || finishedAt === null) return null;
  const durationSeconds = Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(durationSeconds)) return null;
  if (durationSeconds < 60) return `Ran for ${durationSeconds}s`;
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  return seconds === 0 ? `Ran for ${minutes}m` : `Ran for ${minutes}m ${seconds}s`;
}
