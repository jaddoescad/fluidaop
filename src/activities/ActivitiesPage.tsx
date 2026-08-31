import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { SideNav } from '../components/AppChrome';
import '../variants/flow.css';
import '../variants/zen.css';
import './activities.css';

type ActivityMode = 'agent' | 'script';

interface ActivityExecution {
  activityId: string;
  id: string;
  automationKey: string;
  automationName: string;
  automationMode: ActivityMode;
  jobId: string;
  jobName: string;
  profile: string;
  status: string;
  source: string;
  attempt: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  sessionId: string | null;
  model: string | null;
  messageCount: number | null;
  toolCallCount: number | null;
  outcome: string;
  resultCount: number;
}

interface ActivityResult {
  id: string;
  status: string;
  model: string | null;
  promptVersion: string | null;
  error: string | null;
  subject: { type: 'signal'; id: string };
  signal: {
    id: number;
    subject: string | null;
    preview: string | null;
    event_type: string;
    actor_name: string | null;
    occurred_at: string;
  } | null;
  result: {
    schemaVersion: number;
    kind: string;
    title: string;
    summary: string;
    payload: Record<string, unknown>;
  } | null;
}

interface ActivityPagePayload {
  items: ActivityExecution[];
  nextCursor: string | null;
}

interface ActivityDetailPayload {
  activity: ActivityExecution;
  results: ActivityResult[];
}

function detailIdFromPath(): string | null {
  const match = /^\/activity\/([^/]+)$/.exec(window.location.pathname);
  if (!match?.[1]) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' }, signal });
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : `Activity returned HTTP ${response.status}`);
  }
  return payload as T;
}

function duration(start: string | null, finish: string | null): string {
  if (!start) return 'Duration unavailable';
  const startMs = Date.parse(start);
  const endMs = finish ? Date.parse(finish) : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 'Duration unavailable';
  const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function stamp(value: string | null): string {
  if (!value) return 'Time unavailable';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed)
    : value;
}

function sourceLabel(value: string): string {
  if (value === 'direct' || value === 'manual') return 'Manual';
  if (value === 'builtin' || value === 'chronos' || value === 'scheduled') return 'Scheduled';
  return value ? value.replace(/[-_]/g, ' ') : 'Unknown source';
}

function openPath(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function ActivitiesPage({
  onNavigate,
  header,
}: {
  onNavigate: (label: string) => void;
  header: ReactNode;
}) {
  const [detailId, setDetailId] = useState<string | null>(detailIdFromPath);
  const [items, setItems] = useState<ActivityExecution[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [mode, setMode] = useState<'all' | ActivityMode>('all');
  const [status, setStatus] = useState<'all' | 'completed' | 'running' | 'failed'>('all');
  const [detail, setDetail] = useState<ActivityDetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const sync = () => setDetailId(detailIdFromPath());
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const loadPage = useCallback(async (cursor: string | null = null) => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ limit: '30' });
      if (cursor) query.set('cursor', cursor);
      if (mode !== 'all') query.set('mode', mode);
      if (status !== 'all') query.set('status', status);
      const payload = await api<ActivityPagePayload>(`/api/activity?${query}`);
      setItems((current) => cursor && current ? [...current, ...payload.items] : payload.items);
      setNextCursor(payload.nextCursor);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load Activity');
    } finally {
      setLoading(false);
    }
  }, [mode, status]);

  useEffect(() => { if (detailId === null) void loadPage(); }, [detailId, loadPage]);

  useEffect(() => {
    if (detailId === null) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setDetail(null);
    void api<ActivityDetailPayload>(`/api/activity/${encodeURIComponent(detailId)}`, controller.signal)
      .then((value) => { setDetail(value); setError(null); })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not load Activity detail');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [detailId]);

  const counts = useMemo(() => ({
    agents: items?.filter((item) => item.automationMode === 'agent').length ?? 0,
    scripts: items?.filter((item) => item.automationMode === 'script').length ?? 0,
  }), [items]);

  const openDetail = (id: string) => openPath(`/activity/${encodeURIComponent(id)}`);
  const closeDetail = () => openPath('/activity');

  return (
    <div className="v v-flow v-zen aa-page">
      <div className="fl-shell">
        <SideNav active="Activity" onNav={onNavigate} />
        <div className="fl-frame">
          {header}
          <main className="aa-main">
            {detailId !== null ? (
              <ActivityDetail detail={detail} loading={loading} error={error} onBack={closeDetail} />
            ) : (
              <>
                <header className="aa-header">
                  <div>
                    <p className="aa-eyebrow">Hermes execution ledger</p>
                    <h1>Activity</h1>
                    <p>Every registered schedule invocation, including no-work ticks and manual runs.</p>
                  </div>
                  <button type="button" onClick={() => void loadPage()} disabled={loading}>Refresh</button>
                </header>
                <div className="aa-toolbar" aria-label="Activity filters">
                  <span>{items === null ? 'Loading' : `${items.length} executions · ${counts.agents} agents · ${counts.scripts} scripts`}</span>
                  <div>
                    {(['all', 'agent', 'script'] as const).map((value) => (
                      <button type="button" className={mode === value ? 'is-active' : ''} onClick={() => setMode(value)} key={value}>
                        {value === 'all' ? 'All' : `${value[0].toUpperCase()}${value.slice(1)}s`}
                      </button>
                    ))}
                  </div>
                  <div>
                    {(['all', 'completed', 'running', 'failed'] as const).map((value) => (
                      <button type="button" className={status === value ? 'is-active' : ''} onClick={() => setStatus(value)} key={value}>
                        {value[0].toUpperCase()}{value.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                {error ? <div className="aa-alert" role="alert">{error}</div> : null}
                {items === null && loading ? <div className="aa-empty">Loading Hermes executions…</div> : null}
                {items?.length === 0 ? <div className="aa-empty">No executions match these filters.</div> : null}
                {items && items.length > 0 ? (
                  <ol className="aa-list">
                    {items.map((item) => (
                      <li key={`${item.profile}:${item.id}`}>
                        <button type="button" className="aa-row" onClick={() => openDetail(item.activityId)}>
                          <span className={`aa-status is-${item.status}`} aria-hidden="true" />
                          <span className="aa-row-main">
                            <span className="aa-row-title">
                              <b>{item.automationName}</b>
                              <span>{item.automationMode === 'agent' ? 'Agent' : 'Script'}</span>
                              <span>{item.status}</span>
                              <span>{sourceLabel(item.source)}</span>
                            </span>
                            <span className="aa-outcome">{item.outcome}</span>
                          </span>
                          <span className="aa-row-side">
                            <time dateTime={item.startedAt ?? undefined}>{stamp(item.startedAt)}</time>
                            <span>{duration(item.startedAt, item.finishedAt)}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : null}
                {nextCursor ? (
                  <button className="aa-more" type="button" onClick={() => void loadPage(nextCursor)} disabled={loading}>
                    {loading ? 'Loading…' : 'Load older executions'}
                  </button>
                ) : null}
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function ActivityDetail({
  detail,
  loading,
  error,
  onBack,
}: {
  detail: ActivityDetailPayload | null;
  loading: boolean;
  error: string | null;
  onBack: () => void;
}) {
  if (loading && !detail) return <div className="aa-empty">Loading execution…</div>;
  if (error && !detail) return (
    <div className="aa-detail"><button type="button" onClick={onBack}>← Activity</button><div className="aa-alert">{error}</div></div>
  );
  if (!detail) return null;
  const run = detail.activity;
  const facts = [
    ['Type', run.automationMode === 'agent' ? 'Agent' : 'Script'],
    ['Status', run.status],
    ['Source', sourceLabel(run.source)],
    ['Attempt', run.attempt === null ? 'Not recorded' : String(run.attempt)],
    ['Started', stamp(run.startedAt)],
    ['Duration', duration(run.startedAt, run.finishedAt)],
    ['Profile', run.profile],
    ['Hermes execution', run.id],
    ['Hermes session', run.sessionId ?? 'No agent session'],
    ['Model', run.model ?? 'No model session'],
    ['Messages', run.messageCount === null ? 'Not recorded' : String(run.messageCount)],
    ['Tool calls', run.toolCallCount === null ? 'Not recorded' : String(run.toolCallCount)],
  ];
  return (
    <article className="aa-detail">
      <button type="button" className="aa-back" onClick={onBack}>← Activity</button>
      <header>
        <p className="aa-eyebrow">{run.automationMode === 'agent' ? 'Agent execution' : 'Script execution'}</p>
        <h1>{run.automationName}</h1>
        <p>{run.outcome}</p>
      </header>
      <dl className="aa-facts">
        {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      {run.error ? <section className="aa-error"><h2>Safe error details</h2><p>{run.error}</p></section> : null}
      <section className="aa-results">
        <h2>Stored results and Signals</h2>
        {detail.results.length === 0 ? (
          <p className="aa-empty-inline">No Signal result was stored for this invocation.</p>
        ) : detail.results.map((result) => (
          <article key={result.id} className="aa-result">
            <div>
              <span className={`aa-result-status is-${result.status}`}>{result.status}</span>
              <h3>{result.result?.title ?? 'Legacy agent result'}</h3>
              <p>{result.result?.summary ?? result.error ?? 'This result predates presentation metadata.'}</p>
            </div>
            <a href={`/?signal=${encodeURIComponent(result.subject.id)}`}>
              Open Signal{result.signal?.subject ? ` · ${result.signal.subject}` : ''}
            </a>
          </article>
        ))}
      </section>
    </article>
  );
}
