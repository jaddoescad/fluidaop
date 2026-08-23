import { useCallback, useEffect, useRef, useState } from 'react';
import { Derived } from '../variants/shared';
import { SideNav } from '../variants/kit';
import '../variants/flow.css';
import '../variants/zen.css';
import './activities.css';

/**
 * Activity — the operational timeline of the connected Gmail inbox.
 * Every row on this page is a real synced message from the activities
 * API; the page never invents data, and every state (loading, failed,
 * empty, syncing) says exactly what is true.
 */

type ActivityFilter = 'all' | 'needs_reply' | 'received' | 'sent' | 'attachments';

interface ActivityRow {
  id: number;
  account_email: string;
  direction: 'inbound' | 'outbound';
  actor_name: string | null;
  actor_email: string | null;
  from_email: string | null;
  to_emails: string[];
  cc_emails: string[];
  subject: string;
  preview: string;
  occurred_at: string;
  is_unread: boolean;
  has_attachments: boolean;
  attachment_count: number;
  needs_attention: boolean;
  contact_id: string | null;
  source_labels: string[];
}

interface ActivityDetail extends ActivityRow {
  body_text: string | null;
}

interface ActivityCounts {
  all: number;
  needsReply: number;
  received: number;
  sent: number;
  attachments: number;
}

interface SyncState {
  last_sync_status: 'idle' | 'running' | 'succeeded' | 'failed';
  last_sync_completed_at: string | null;
  messages_upserted: number;
  last_error: string | null;
}

interface ActivitiesPayload {
  activities: ActivityRow[];
  counts: ActivityCounts;
  sync: SyncState | null;
}

const FILTERS: { key: ActivityFilter; label: string; count: (c: ActivityCounts) => number }[] = [
  { key: 'all', label: 'All', count: (c) => c.all },
  { key: 'needs_reply', label: 'Needs reply', count: (c) => c.needsReply },
  { key: 'received', label: 'Received', count: (c) => c.received },
  { key: 'sent', label: 'Sent', count: (c) => c.sent },
  { key: 'attachments', label: 'Attachments', count: (c) => c.attachments },
];

// ---------- API ----------

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = `the server answered HTTP ${res.status}`;
    try {
      const body: unknown = await res.json();
      if (
        body !== null &&
        typeof body === 'object' &&
        'error' in body &&
        typeof (body as { error: unknown }).error === 'string'
      ) {
        detail = (body as { error: string }).error;
      }
    } catch {
      // non-JSON error body — keep the status text
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------- time ----------

function parseIso(iso: string | null): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function fmtClock(iso: string): string {
  const t = parseIso(iso);
  if (t === null) return '';
  return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function fmtFull(iso: string | null): string {
  const t = parseIso(iso);
  return t === null ? 'Not yet' : new Date(t).toLocaleString();
}

function fmtPast(iso: string | null, now: number): string {
  const t = parseIso(iso);
  if (t === null) return 'not yet';
  const diff = Math.max(0, now - t);
  if (diff < 45_000) return 'just now';
  if (diff < 90_000) return 'a minute ago';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} minutes ago`;
  if (diff < 5_400_000) return 'an hour ago';
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} hours ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "Today", "Yesterday", or a plain date — local calendar days. */
function dayLabel(iso: string, now: number): string {
  const t = parseIso(iso);
  if (t === null) return 'Undated';
  const d = new Date(t);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const daysAgo = Math.round((startOf(new Date(now)) - startOf(d)) / 86_400_000);
  if (daysAgo === 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}),
  });
}

function groupByDay(rows: ActivityRow[], now: number): { label: string; items: ActivityRow[] }[] {
  const groups: { label: string; items: ActivityRow[] }[] = [];
  for (const row of rows) {
    const label = dayLabel(row.occurred_at, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(row);
    else groups.push({ label, items: [row] });
  }
  return groups;
}

// ---------- people ----------

/** The counterparty as one short scannable name. */
function personOf(row: ActivityRow): string {
  if (row.actor_name !== null && row.actor_name !== '') return row.actor_name;
  if (row.actor_email !== null && row.actor_email !== '') return row.actor_email;
  if (row.direction === 'inbound') return row.from_email ?? 'Unknown sender';
  return row.to_emails[0] ?? 'Unknown recipient';
}

function listEmails(emails: string[]): string {
  return emails.filter((e) => e !== '').join(', ');
}

// ---------- small pieces ----------

/** The Gmail envelope mark, drawn inline — no remote image. */
function GmailLogo() {
  return (
    <span className="ac-logo" aria-hidden="true">
      <svg viewBox="52 42 88 66" width="18" height="13.5" focusable="false">
        <path fill="#4285f4" d="M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6" />
        <path fill="#34a853" d="M120 108h14c3.32 0 6-2.69 6-6V59l-20 15" />
        <path fill="#fbbc04" d="M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2" />
        <path fill="#ea4335" d="M72 74V48l24 18 24-18v26L96 92" />
        <path fill="#c5221f" d="M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2" />
      </svg>
    </span>
  );
}

function DirectionMark({ direction }: { direction: ActivityRow['direction'] }) {
  const inbound = direction === 'inbound';
  return (
    <span
      className={`ac-dir ${inbound ? 'ac-dir-in' : 'ac-dir-out'}`}
      title={inbound ? 'Received' : 'Sent'}
    >
      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">
        {inbound ? (
          <path
            d="M9.5 3.5 3.8 9.2M4 4.6v4.6h4.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <path
            d="M2.5 9.5 8.2 3.8M8 8.4V3.8H3.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
      <span className="ac-sr">{inbound ? 'Received' : 'Sent'}</span>
    </span>
  );
}

function AttachmentClip({ count }: { count: number }) {
  return (
    <span className="ac-clip" title={`${count} attachment${count === 1 ? '' : 's'}`}>
      <svg viewBox="0 0 14 14" width="11" height="11" aria-hidden="true" focusable="false">
        <path
          d="M10.6 6.3 6.9 10a2.4 2.4 0 0 1-3.4-3.4l4.2-4.2a1.6 1.6 0 0 1 2.3 2.3L5.8 8.9a.8.8 0 0 1-1.1-1.1l3.4-3.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {count > 1 && <span className="ac-clip-n">{count}</span>}
      <span className="ac-sr">{count} attachment{count === 1 ? '' : 's'}</span>
    </span>
  );
}

// ---------- detail drawer ----------

function Participants({ activity }: { activity: ActivityDetail }) {
  const rows: { label: string; value: string }[] = [];
  if (activity.from_email !== null && activity.from_email !== '') {
    rows.push({ label: 'From', value: activity.from_email });
  }
  if (activity.to_emails.length > 0) rows.push({ label: 'To', value: listEmails(activity.to_emails) });
  if (activity.cc_emails.length > 0) rows.push({ label: 'Cc', value: listEmails(activity.cc_emails) });
  return (
    <dl className="ac-parts">
      {rows.map((r) => (
        <div key={r.label} className="ac-part">
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DetailDrawer({
  row,
  onClose,
}: {
  row: ActivityRow;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<ActivityDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    api<{ activity: ActivityDetail }>(`/api/activities/${row.id}`)
      .then(({ activity }) => {
        if (!cancelled) setDetail(activity);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [row.id]);

  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const body = detail?.body_text ?? null;

  return (
    <div className="ac-scrim" onClick={onClose}>
      <aside
        ref={panelRef}
        className="ac-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={row.subject !== '' ? row.subject : 'Email activity'}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ac-drawer-head">
          <div className="ac-drawer-meta">
            <DirectionMark direction={row.direction} />
            <span className="ac-drawer-when" title={fmtFull(row.occurred_at)}>
              {fmtFull(row.occurred_at)}
            </span>
            {row.needs_attention && <span className="ac-chip ac-chip-reply">needs reply</span>}
            {row.has_attachments && <AttachmentClip count={row.attachment_count} />}
          </div>
          <button type="button" className="ac-x" onClick={onClose} aria-label="Close (Esc)">
            ✕
          </button>
        </header>
        <h2 className="ac-drawer-subject">{row.subject !== '' ? row.subject : '(no subject)'}</h2>
        {detail !== null && <Participants activity={detail} />}
        <div className="ac-drawer-body">
          {error !== null ? (
            <p className="ac-drawer-problem" role="alert">
              Couldn’t load this message: {error}
            </p>
          ) : detail === null ? (
            <p className="ac-drawer-loading" role="status">
              Loading the message…
            </p>
          ) : body !== null && body.trim() !== '' ? (
            <pre className="ac-body-text">{body}</pre>
          ) : (
            <p className="ac-drawer-loading">
              No plain-text body was stored for this message — only the preview:{' '}
              {row.preview !== '' ? `“${row.preview}”` : 'none.'}
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}

// ---------- the page ----------

export function ActivitiesPage({
  d,
  onNavigate,
}: {
  d: Derived;
  onNavigate: (label: string) => void;
}) {
  const [payload, setPayload] = useState<ActivitiesPayload | null>(null);
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ActivityRow | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async (f: ActivityFilter, initial: boolean) => {
    if (initial) setLoading(true);
    else setRefreshing(true);
    setLoadError(null);
    try {
      const data = await api<ActivitiesPayload>(`/api/activities?filter=${f}&limit=80`);
      setPayload(data);
      setNow(Date.now());
    } catch (e) {
      setLoadError(errText(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(filter, payload === null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, load]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(tick);
  }, []);

  const sync = async () => {
    setSyncing(true);
    setSyncError(null);
    setSyncNote(null);
    try {
      const { sync: result } = await api<{ sync: { imported: number } }>('/api/activities/sync', {
        method: 'POST',
      });
      setSyncNote(
        result.imported === 0
          ? 'Synced — already up to date.'
          : `Synced — ${result.imported} message${result.imported === 1 ? '' : 's'} updated.`,
      );
      await load(filter, false);
    } catch (e) {
      setSyncError(`Sync failed: ${errText(e)}`);
    } finally {
      setSyncing(false);
    }
  };

  const rows = payload?.activities ?? [];
  const counts = payload?.counts ?? null;
  const syncState = payload?.sync ?? null;
  const accountEmail = rows[0]?.account_email ?? null;
  const activeFilter = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];

  return (
    <div className="v v-flow v-zen ac-root">
      <div className="fl-shell">
        <SideNav d={d} active="Activity" onNav={onNavigate} />
        <div className="fl-frame">
          <main className="ac-main">
            <div className="ac-inner">
              <header className="ac-head">
                <div className="ac-head-text">
                  <h1>Activity</h1>
                  <p>Everything that has happened on the connected inbox, newest first.</p>
                </div>
                <div className="ac-source">
                  <GmailLogo />
                  <div className="ac-source-text">
                    <b>{accountEmail ?? 'Gmail'}</b>
                    {syncState !== null ? (
                      <span
                        className={syncState.last_sync_status === 'failed' ? 'ac-sync-bad' : ''}
                        title={fmtFull(syncState.last_sync_completed_at)}
                      >
                        {syncState.last_sync_status === 'running'
                          ? 'sync in progress'
                          : syncState.last_sync_status === 'failed'
                          ? `last sync failed ${fmtPast(syncState.last_sync_completed_at, now)}`
                          : `synced ${fmtPast(syncState.last_sync_completed_at, now)}`}
                      </span>
                    ) : (
                      <span>not synced yet</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="ac-btn ac-btn-primary"
                    onClick={() => void sync()}
                    disabled={syncing}
                  >
                    {syncing ? 'Syncing…' : 'Sync Gmail'}
                  </button>
                </div>
              </header>

              {syncState !== null &&
                syncState.last_sync_status === 'failed' &&
                syncState.last_error !== null && (
                  <p className="ac-warnline" role="status">
                    The last sync failed: {syncState.last_error}
                  </p>
                )}

              {syncNote !== null && (
                <p className="ac-okline" role="status">
                  {syncNote}
                </p>
              )}

              {syncError !== null && (
                <p className="ac-errline" role="alert">
                  {syncError}
                </p>
              )}

              {counts !== null && (
                <div className="ac-filters" role="tablist" aria-label="Filter activity">
                  {FILTERS.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      role="tab"
                      aria-selected={f.key === filter}
                      className={`ac-filter${f.key === filter ? ' on' : ''}`}
                      onClick={() => setFilter(f.key)}
                    >
                      {f.label}
                      <span className="ac-filter-n">{f.count(counts)}</span>
                    </button>
                  ))}
                  {refreshing && (
                    <span className="ac-refreshing" role="status">
                      updating…
                    </span>
                  )}
                </div>
              )}

              {loading ? (
                <div className="ac-state" role="status">
                  <i className="ac-pulse" />
                  Loading activity…
                </div>
              ) : loadError !== null ? (
                <div className="ac-state ac-state-error" role="alert">
                  <p>
                    <b>Activity couldn’t be loaded.</b> {loadError}
                  </p>
                  <button type="button" className="ac-btn" onClick={() => void load(filter, true)}>
                    Try again
                  </button>
                </div>
              ) : rows.length === 0 ? (
                <div className="ac-state">
                  {filter === 'all' ? (
                    <p>
                      No activity has been synced yet. Connect Gmail on the Connections page, then
                      use <b>Sync Gmail</b> above to pull in the inbox.
                    </p>
                  ) : (
                    <p>
                      Nothing matches <b>{activeFilter.label.toLowerCase()}</b> — try another
                      filter.
                    </p>
                  )}
                </div>
              ) : (
                <section
                  className={`ac-feed${refreshing ? ' ac-feed-stale' : ''}`}
                  aria-busy={refreshing}
                  aria-label="Activity feed"
                >
                  {groupByDay(rows, now).map((g) => (
                    <div key={g.label} className="ac-day">
                      <h2 className="ac-day-label">{g.label}</h2>
                      <ul className="ac-list">
                        {g.items.map((row) => (
                          <li key={row.id}>
                            <button
                              type="button"
                              className={`ac-row${row.is_unread ? ' unread' : ''}`}
                              onClick={() => setSelected(row)}
                            >
                              <DirectionMark direction={row.direction} />
                              <span className="ac-row-main">
                                <span className="ac-row-top">
                                  <span className="ac-row-person">{personOf(row)}</span>
                                  {row.needs_attention && (
                                    <span className="ac-chip ac-chip-reply">needs reply</span>
                                  )}
                                  {row.has_attachments && (
                                    <AttachmentClip count={row.attachment_count} />
                                  )}
                                </span>
                                <span className="ac-row-line">
                                  <span className="ac-row-subject">
                                    {row.subject !== '' ? row.subject : '(no subject)'}
                                  </span>
                                  {row.preview !== '' && (
                                    <span className="ac-row-preview"> — {row.preview}</span>
                                  )}
                                </span>
                              </span>
                              <span className="ac-row-side">
                                <time
                                  className="ac-row-time"
                                  dateTime={row.occurred_at}
                                  title={fmtFull(row.occurred_at)}
                                >
                                  {fmtClock(row.occurred_at)}
                                </time>
                                {row.is_unread && (
                                  <i className="ac-unread-dot" title="Unread">
                                    <span className="ac-sr">Unread</span>
                                  </i>
                                )}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  {counts !== null && rows.length < activeFilter.count(counts) && (
                    <p className="ac-truncnote">
                      Showing the latest {rows.length} of {activeFilter.count(counts)} — older
                      messages stay in the synced history.
                    </p>
                  )}
                </section>
              )}
            </div>
          </main>
        </div>
      </div>
      {selected !== null && <DetailDrawer row={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
