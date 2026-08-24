import { useCallback, useEffect, useRef, useState } from 'react';
import { Derived } from '../variants/shared';
import { SideNav } from '../variants/kit';
import '../variants/flow.css';
import '../variants/zen.css';
import './activities.css';

/**
 * Activity — the signal feed across every connected source. One email is
 * one signal; Gmail is the first source, and each row carries the logo of
 * the tool it came from. A Gmail thread is only supporting history for a
 * selected signal, never the unit itself — labels and links will belong
 * to the signal alone. Every row is real synced data from the activities
 * API; the page never invents data, and every state (loading, failed,
 * empty, syncing) says exactly what is true. This is not an inbox: there
 * is no read state and no reply bookkeeping — the feed exists so these
 * signals can eventually become actions.
 */

const PAGE_SIZE = 30;
const HISTORY_PAGE_SIZE = 5;

interface Cursor {
  occurredAt: string;
  id: number;
}

interface SignalClassification {
  confidence: number | null;
  reason: string;
  updated_at: string;
  label: {
    key: string;
    name: string;
    color: string;
  } | null;
}

interface AttachmentEvidence {
  attachment_key: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  extraction_status: 'metadata' | 'extracted' | 'no_text' | 'unsupported' | 'failed';
  extraction_method: string | null;
  updated_at: string;
}

interface SignalSummary {
  id: number;
  source: 'gmail';
  account_email: string;
  external_id: string;
  external_thread_id: string | null;
  direction: 'inbound' | 'outbound';
  actor_name: string | null;
  actor_email: string | null;
  from_email: string | null;
  to_emails: string[];
  cc_emails: string[];
  subject: string;
  preview: string;
  occurred_at: string;
  has_attachments: boolean;
  attachment_count: number;
  contact_id: string | null;
  classification?: SignalClassification | null;
}

interface SignalDetail extends SignalSummary {
  body_text: string | null;
  attachmentEvidence?: AttachmentEvidence[];
}

interface SyncState {
  last_sync_status: 'idle' | 'running' | 'succeeded' | 'failed';
  last_sync_completed_at: string | null;
  messages_upserted: number;
  last_error: string | null;
}

interface ActivitiesPayload {
  signals: SignalSummary[];
  count: number;
  nextCursor: Cursor | null;
  sync: SyncState | null;
  automaticSyncIntervalMs: number;
}

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

function cursorQuery(limit: number, cursor: Cursor | null): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor !== null) {
    params.set('cursorAt', cursor.occurredAt);
    params.set('cursorId', String(cursor.id));
  }
  return params.toString();
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

function groupByDay(rows: SignalSummary[], now: number): { label: string; items: SignalSummary[] }[] {
  const groups: { label: string; items: SignalSummary[] }[] = [];
  for (const row of rows) {
    const label = dayLabel(row.occurred_at, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(row);
    else groups.push({ label, items: [row] });
  }
  return groups;
}

// ---------- people ----------

/** The counterparty of a signal as one short scannable name. */
function personOf(signal: SignalSummary): string {
  if (signal.actor_name !== null && signal.actor_name !== '') return signal.actor_name;
  if (signal.actor_email !== null && signal.actor_email !== '') return signal.actor_email;
  if (signal.direction === 'inbound') return signal.from_email ?? 'Unknown sender';
  return signal.to_emails[0] ?? 'Unknown recipient';
}

/** Who wrote a specific email. */
function senderOf(signal: SignalSummary): string {
  if (signal.direction === 'outbound') {
    return signal.from_email !== null && signal.from_email !== ''
      ? signal.from_email
      : signal.account_email;
  }
  if (signal.actor_name !== null && signal.actor_name !== '') return signal.actor_name;
  if (signal.actor_email !== null && signal.actor_email !== '') return signal.actor_email;
  return signal.from_email ?? 'Unknown sender';
}

/** The From line of a signal, with the sender's name when it is known. */
function fromLine(signal: SignalSummary): string {
  const email = signal.from_email ?? '';
  if (signal.direction === 'inbound') {
    const name = signal.actor_name ?? '';
    if (name !== '' && email !== '') return `${name} <${email}>`;
  }
  if (email !== '') return email;
  return signal.direction === 'outbound' ? signal.account_email : 'Unknown sender';
}

// ---------- small pieces ----------

/**
 * The logo of the tool an activity came from, drawn inline — no remote
 * image. Gmail is the only source today; new sources add a case here.
 */
function SourceLogo({ source, small = false }: { source: 'gmail'; small?: boolean }) {
  return (
    <span
      className={`ac-logo${small ? ' ac-logo-sm' : ''}`}
      title={source === 'gmail' ? 'From Gmail' : undefined}
    >
      <svg
        viewBox="52 42 88 66"
        width={small ? 15 : 18}
        height={small ? 11.25 : 13.5}
        aria-hidden="true"
        focusable="false"
      >
        <path fill="#4285f4" d="M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6" />
        <path fill="#34a853" d="M120 108h14c3.32 0 6-2.69 6-6V59l-20 15" />
        <path fill="#fbbc04" d="M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2" />
        <path fill="#ea4335" d="M72 74V48l24 18 24-18v26L96 92" />
        <path fill="#c5221f" d="M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2" />
      </svg>
      <span className="ac-sr">{source === 'gmail' ? 'From Gmail' : ''}</span>
    </span>
  );
}

function DirectionMark({ direction }: { direction: 'inbound' | 'outbound' }) {
  const inbound = direction === 'inbound';
  const text = inbound ? 'Received' : 'Sent';
  return (
    <span className={`ac-dir ${inbound ? 'ac-dir-in' : 'ac-dir-out'}`} title={text}>
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
      <span className="ac-sr">{text}</span>
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

// ---------- Gmail history (context only, fetched on demand) ----------

function HistoryItem({ message }: { message: SignalDetail }) {
  const body = message.body_text;
  const hasBody = body !== null && body.trim() !== '';
  return (
    <li className="ac-hist-item">
      <header className="ac-hist-head">
        <DirectionMark direction={message.direction} />
        <span className="ac-hist-sender">{senderOf(message)}</span>
        <time className="ac-hist-time" dateTime={message.occurred_at}>
          {fmtFull(message.occurred_at)}
        </time>
      </header>
      {message.subject !== '' && <p className="ac-hist-subject">{message.subject}</p>}
      {hasBody ? (
        <pre className="ac-body-text ac-hist-body">{body}</pre>
      ) : (
        <p className="ac-nobody">
          No plain-text body was stored for this email
          {message.preview !== '' ? ` — only the preview: “${message.preview}”` : '.'}
        </p>
      )}
    </li>
  );
}

/**
 * The rest of the Gmail thread a signal belongs to — collapsed by default
 * and never requested until the user opens it. Strictly context: nothing
 * here is a signal, and labels and links will apply to the selected
 * signal only.
 */
function GmailHistory({ signalId, count }: { signalId: number; count: number }) {
  const [open, setOpen] = useState(false);
  const [pageStack, setPageStack] = useState<(Cursor | null)[]>([null]);
  const [messages, setMessages] = useState<SignalDetail[] | null>(null);
  const [nextCursor, setNextCursor] = useState<Cursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cursor = pageStack[pageStack.length - 1] ?? null;
  const page = pageStack.length;
  const totalPages = Math.max(1, Math.ceil(count / HISTORY_PAGE_SIZE));

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<{ messages: SignalDetail[]; count: number; nextCursor: Cursor | null }>(
      `/api/activities/signals/${signalId}/history?${cursorQuery(HISTORY_PAGE_SIZE, cursor)}`,
    )
      .then((data) => {
        if (cancelled) return;
        setMessages(data.messages);
        setNextCursor(data.nextCursor);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errText(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, signalId, cursor]);

  const panelId = `ac-hist-panel-${signalId}`;

  return (
    <section className="ac-hist" aria-label="Gmail history">
      <button
        type="button"
        className="ac-hist-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <svg
          className="ac-hist-chev"
          viewBox="0 0 10 10"
          width="9"
          height="9"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M3.5 2 7 5 3.5 8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Gmail history
        <span className="ac-hist-count">
          {count} other email{count === 1 ? '' : 's'}
        </span>
      </button>
      {open && (
        <div id={panelId} className="ac-hist-panel">
          <p className="ac-hist-note">
            Context only. Labels and links apply to the selected signal.
          </p>
          {error !== null ? (
            <p className="ac-drawer-problem" role="alert">
              Couldn’t load the Gmail history: {error}
            </p>
          ) : messages === null ? (
            <p className="ac-drawer-loading" role="status">
              Loading the history…
            </p>
          ) : messages.length === 0 ? (
            <p className="ac-drawer-loading">No other emails were found.</p>
          ) : (
            <ol
              className={`ac-hist-list${loading ? ' ac-feed-stale' : ''}`}
              aria-busy={loading}
              aria-label={`${messages.length} emails from the same Gmail thread, newest first`}
            >
              {messages.map((m) => (
                <HistoryItem key={m.id} message={m} />
              ))}
            </ol>
          )}
          {count > HISTORY_PAGE_SIZE && (
            <footer className="ac-pager ac-hist-pager">
              <span className="ac-pager-info">
                Page {page} of {totalPages}
              </span>
              <span className="ac-pager-btns">
                <button
                  type="button"
                  className="ac-btn ac-btn-sm"
                  disabled={page === 1 || loading}
                  onClick={() => setPageStack((s) => (s.length > 1 ? s.slice(0, -1) : s))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="ac-btn ac-btn-sm"
                  disabled={nextCursor === null || loading}
                  onClick={() => {
                    if (nextCursor !== null) setPageStack((s) => [...s, nextCursor]);
                  }}
                >
                  Next
                </button>
              </span>
            </footer>
          )}
        </div>
      )}
    </section>
  );
}

// ---------- signal drawer ----------

function SignalDrawer({ signal, onClose }: { signal: SignalSummary; onClose: () => void }) {
  const [detail, setDetail] = useState<SignalDetail | null>(null);
  const [historyCount, setHistoryCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setHistoryCount(null);
    setError(null);
    api<{ signal: SignalDetail; historyCount: number }>(`/api/activities/signals/${signal.id}`)
      .then((data) => {
        if (cancelled) return;
        setDetail(data.signal);
        setHistoryCount(data.historyCount);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [signal.id]);

  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // the feed summary carries every field but the body, so the signal is
  // readable immediately while the detail request fills in the body
  const s = detail ?? signal;
  const subject = s.subject !== '' ? s.subject : '(no subject)';
  const body = detail?.body_text ?? null;
  const hasBody = body !== null && body.trim() !== '';

  return (
    <div className="ac-scrim" onClick={onClose}>
      <aside
        ref={panelRef}
        className="ac-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Signal: ${subject}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ac-drawer-head">
          <div className="ac-drawer-meta">
            <SourceLogo source="gmail" small />
            <DirectionMark direction={s.direction} />
            <span className="ac-drawer-when">
              {s.direction === 'inbound' ? 'Received' : 'Sent'} ·{' '}
              <time dateTime={s.occurred_at}>{fmtFull(s.occurred_at)}</time>
            </span>
          </div>
          <button type="button" className="ac-x" onClick={onClose} aria-label="Close (Esc)">
            ✕
          </button>
        </header>

        <section className="ac-signal" aria-label="Selected signal">
          <span className="ac-signal-tag">Signal</span>
          <h2 className="ac-drawer-subject">{subject}</h2>
          {s.classification?.label && (
            <div
              className="ac-classification"
              style={{ ['--ac-label' as string]: s.classification.label.color }}
            >
              <span className="ac-classification-pill">{s.classification.label.name}</span>
              {s.classification.confidence !== null && (
                <span className="ac-classification-confidence">
                  {Math.round(s.classification.confidence * 100)}% confidence
                </span>
              )}
              {s.classification.reason !== '' && (
                <p>{s.classification.reason}</p>
              )}
            </div>
          )}
          <dl className="ac-parts">
            <div className="ac-part">
              <dt>From</dt>
              <dd>{fromLine(s)}</dd>
            </div>
            <div className="ac-part">
              <dt>To</dt>
              <dd>{s.to_emails.length > 0 ? s.to_emails.join(', ') : '—'}</dd>
            </div>
            {s.cc_emails.length > 0 && (
              <div className="ac-part">
                <dt>Cc</dt>
                <dd>{s.cc_emails.join(', ')}</dd>
              </div>
            )}
            {s.has_attachments && (
              <div className="ac-part">
                <dt>Files</dt>
                <dd>
                  {s.attachment_count} attachment{s.attachment_count === 1 ? '' : 's'}
                </dd>
              </div>
            )}
          </dl>
          {detail?.attachmentEvidence && detail.attachmentEvidence.length > 0 && (
            <div className="ac-evidence" aria-label="Attachment evidence stored by Hermes">
              <span className="ac-evidence-title">Attachment evidence</span>
              <ul>
                {detail.attachmentEvidence.map((attachment) => (
                  <li key={attachment.attachment_key}>
                    <span>{attachment.filename ?? 'Unnamed attachment'}</span>
                    <small>{attachment.extraction_status.replace('_', ' ')}</small>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {error !== null ? (
            <p className="ac-drawer-problem" role="alert">
              Couldn’t load this signal: {error}
            </p>
          ) : detail === null ? (
            <p className="ac-drawer-loading" role="status">
              Loading the signal…
            </p>
          ) : hasBody ? (
            <pre className="ac-body-text">{body}</pre>
          ) : (
            <p className="ac-nobody">
              No plain-text body was stored for this email
              {s.preview !== '' ? ` — only the preview: “${s.preview}”` : '.'}
            </p>
          )}
        </section>

        {historyCount !== null &&
          (historyCount > 0 ? (
            <GmailHistory signalId={signal.id} count={historyCount} />
          ) : (
            <p className="ac-hist-none">No other emails in this Gmail thread.</p>
          ))}
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
  const [pageStack, setPageStack] = useState<(Cursor | null)[]>([null]);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SignalSummary | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const activeCursorRef = useRef<Cursor | null>(null);
  const loadSequenceRef = useRef(0);
  const closeSelected = useCallback(() => setSelected(null), []);

  const load = useCallback(
    async (cursor: Cursor | null, mode: 'initial' | 'page' | 'background') => {
      const loadSequence = ++loadSequenceRef.current;
      if (mode === 'initial') setLoading(true);
      else if (mode === 'page') setPaging(true);
      else setRefreshing(true);
      setLoadError(null);
      try {
        const data = await api<ActivitiesPayload>(
          `/api/activities?${cursorQuery(PAGE_SIZE, cursor)}`,
        );
        if (loadSequence !== loadSequenceRef.current) return;
        setPayload(data);
        setNow(Date.now());
      } catch (e) {
        if (loadSequence === loadSequenceRef.current) setLoadError(errText(e));
      } finally {
        if (loadSequence === loadSequenceRef.current) {
          setLoading(false);
          setPaging(false);
          setRefreshing(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    void load(null, 'initial');
  }, [load]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(tick);
  }, []);

  // the automatic background refresh only ever re-reads page 1 — deeper
  // pages hold still so cursors stay meaningful while the user reads
  const onFirstPage = pageStack.length === 1;
  useEffect(() => {
    if (!onFirstPage) return;
    const refresh = () => {
      if (document.visibilityState === 'visible' && activeCursorRef.current === null) {
        void load(null, 'background');
      }
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load, onFirstPage]);

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
          : `Synced — ${result.imported} update${result.imported === 1 ? '' : 's'} pulled in.`,
      );
      setPageStack([null]);
      activeCursorRef.current = null;
      await load(null, 'background');
    } catch (e) {
      setSyncError(`Sync failed: ${errText(e)}`);
    } finally {
      setSyncing(false);
    }
  };

  const signals = payload?.signals ?? [];
  const total = payload?.count ?? null;
  const nextCursor = payload?.nextCursor ?? null;
  const syncState = payload?.sync ?? null;
  const automaticSyncMinutes = Math.max(
    1,
    Math.round((payload?.automaticSyncIntervalMs ?? 300_000) / 60_000),
  );

  const busy = loading || paging || refreshing;
  const page = pageStack.length;
  const firstIndex = (page - 1) * PAGE_SIZE + 1;
  const lastIndex = firstIndex + signals.length - 1;

  const goNext = () => {
    if (nextCursor === null || busy) return;
    activeCursorRef.current = nextCursor;
    setPageStack((s) => [...s, nextCursor]);
    void load(nextCursor, 'page');
  };

  const goPrevious = () => {
    if (page <= 1 || busy) return;
    const trimmed = pageStack.slice(0, -1);
    activeCursorRef.current = trimmed[trimmed.length - 1] ?? null;
    setPageStack(trimmed);
    void load(trimmed[trimmed.length - 1] ?? null, 'page');
  };

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
                  <p>Signals from your connected tools, newest first. One email is one signal.</p>
                </div>
                <div className="ac-sync-controls">
                  <span className="ac-auto-sync">
                    <i aria-hidden="true" />
                    Automatic · every {automaticSyncMinutes} min
                  </span>
                  <button
                    type="button"
                    className="ac-btn ac-btn-primary"
                    onClick={() => void sync()}
                    disabled={syncing}
                    title="Automatic sync is on; use this only to check immediately"
                  >
                    {syncing ? 'Checking…' : 'Check now'}
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

              {refreshing && (
                <span className="ac-refreshing" role="status">
                  updating…
                </span>
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
                  <button
                    type="button"
                    className="ac-btn"
                    onClick={() => void load(pageStack[pageStack.length - 1] ?? null, 'initial')}
                  >
                    Try again
                  </button>
                </div>
              ) : signals.length === 0 && page === 1 ? (
                <div className="ac-state">
                  <p>
                    No activity has been synced yet. Connect a tool on the Connections page, then
                    use <b>Check now</b> above to pull in its history.
                  </p>
                </div>
              ) : (
                <section
                  className={`ac-feed${refreshing || paging ? ' ac-feed-stale' : ''}`}
                  aria-busy={refreshing || paging}
                  aria-label="Activity feed"
                >
                  {groupByDay(signals, now).map((g) => (
                    <div key={g.label} className="ac-day">
                      <h2 className="ac-day-label">{g.label}</h2>
                      <ul className="ac-list">
                        {g.items.map((signal) => (
                          <li key={signal.id}>
                            <button
                              type="button"
                              className="ac-row"
                              onClick={() => setSelected(signal)}
                            >
                              <SourceLogo source="gmail" small />
                              <span className="ac-row-main">
                                <span className="ac-row-top">
                                  <DirectionMark direction={signal.direction} />
                                  <span className="ac-row-person">{personOf(signal)}</span>
                                  {signal.has_attachments && (
                                    <AttachmentClip count={signal.attachment_count} />
                                  )}
                                  {signal.classification?.label && (
                                    <span
                                      className="ac-row-label"
                                      style={{ ['--ac-label' as string]: signal.classification.label.color }}
                                    >
                                      {signal.classification.label.name}
                                    </span>
                                  )}
                                </span>
                                <span className="ac-row-line">
                                  <span className="ac-row-subject">
                                    {signal.subject !== '' ? signal.subject : '(no subject)'}
                                  </span>
                                  {signal.preview !== '' && (
                                    <span className="ac-row-preview"> — {signal.preview}</span>
                                  )}
                                </span>
                              </span>
                              <span className="ac-row-side">
                                <time
                                  className="ac-row-time"
                                  dateTime={signal.occurred_at}
                                  title={fmtFull(signal.occurred_at)}
                                >
                                  {fmtClock(signal.occurred_at)}
                                </time>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  <footer className="ac-pager">
                    <span className="ac-pager-info">
                      Page {page}
                      {total !== null && signals.length > 0
                        ? ` · ${firstIndex}–${lastIndex} of ${total}`
                        : ''}
                    </span>
                    <span className="ac-pager-btns">
                      <button
                        type="button"
                        className="ac-btn ac-btn-sm"
                        disabled={page === 1 || busy}
                        onClick={goPrevious}
                      >
                        Previous
                      </button>
                      <button
                        type="button"
                        className="ac-btn ac-btn-sm"
                        disabled={nextCursor === null || busy}
                        onClick={goNext}
                      >
                        Next
                      </button>
                    </span>
                  </footer>
                </section>
              )}
            </div>
          </main>
        </div>
      </div>
      {selected !== null && <SignalDrawer signal={selected} onClose={closeSelected} />}
    </div>
  );
}
