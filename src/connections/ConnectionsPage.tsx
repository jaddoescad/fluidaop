import { useCallback, useEffect, useRef, useState } from 'react';
import { Derived } from '../variants/shared';
import { SideNav } from '../variants/kit';
import '../variants/flow.css';
import '../variants/zen.css';
import './connections.css';

/**
 * Connections — where the business grants Fluid access to real accounts.
 * Today that is one shared Gmail inbox. The page talks to the real
 * connections API: it never pretends an account is connected, and every
 * action (connect / check / disconnect) reports exactly what happened.
 */

interface GmailConnection {
  id: string;
  provider: 'gmail';
  email: string;
  status: 'connected' | 'error' | 'checking';
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastHealthyAt: string | null;
  nextCheckAt: string | null;
  error: string | null;
}

interface ConnectionsPayload {
  connections: GmailConnection[];
  healthCheckIntervalMs: number;
  configured: boolean;
  configurationError?: string;
}

interface ConnectionLoadFailure {
  status: number | null;
  message: string;
}

/** The inbox this workspace is meant to connect. */
const INTENDED_EMAIL = 'info@paintersottawa.com';

// ---------- API ----------

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = `the server answered ${res.status}`;
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
    throw new ApiError(detail, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function connectionLoadFailure(e: unknown): ConnectionLoadFailure {
  if (e instanceof ApiError) {
    return {
      status: e.status,
      message:
        e.message === `the server answered ${e.status}`
          ? `Fluid's Gmail integration API returned HTTP ${e.status}.`
          : e.message,
    };
  }
  return {
    status: null,
    message: "Fluid's Gmail integration API could not be reached.",
  };
}

// ---------- plain-language time ----------

function parseIso(iso: string | null): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function fmtAbs(iso: string | null): string | undefined {
  const t = parseIso(iso);
  return t === null ? undefined : new Date(t).toLocaleString();
}

function fmtPast(iso: string | null, now: number, never: string): string {
  const t = parseIso(iso);
  if (t === null) return never;
  const diff = Math.max(0, now - t);
  if (diff < 45_000) return 'just now';
  if (diff < 90_000) return 'a minute ago';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} minutes ago`;
  if (diff < 5_400_000) return 'an hour ago';
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} hours ago`;
  if (diff < 172_800_000) return 'yesterday';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtFuture(iso: string | null, now: number): string {
  const t = parseIso(iso);
  if (t === null) return 'not scheduled';
  const diff = t - now;
  if (diff <= 20_000) return 'any moment now';
  if (diff < 90_000) return 'in about a minute';
  if (diff < 3_600_000) return `in about ${Math.round(diff / 60_000)} minutes`;
  return `at ${new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

/** "every 5 minutes" — worded from the interval the server actually returns. */
function everyPhrase(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min <= 1 ? 'every minute' : `every ${min} minutes`;
}

// ---------- small pieces ----------

/** The Gmail envelope mark, drawn inline — no emoji, no remote image. */
function GmailLogo({ dim = false }: { dim?: boolean }) {
  return (
    <span className={`cn-logo${dim ? ' cn-logo-dim' : ''}`} aria-hidden="true">
      <svg viewBox="52 42 88 66" width="22" height="16.5" focusable="false">
        <path fill="#4285f4" d="M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6" />
        <path fill="#34a853" d="M120 108h14c3.32 0 6-2.69 6-6V59l-20 15" />
        <path fill="#fbbc04" d="M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2" />
        <path fill="#ea4335" d="M72 74V48l24 18 24-18v26L96 92" />
        <path fill="#c5221f" d="M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2" />
      </svg>
    </span>
  );
}

function StatusPill({
  status,
}: {
  status: GmailConnection['status'] | 'off' | 'unavailable';
}) {
  const meta =
    status === 'connected'
      ? { cls: 'ok', dot: '', label: 'Connected' }
      : status === 'checking'
        ? { cls: 'accent', dot: ' cn-dot-breathe', label: 'Checking…' }
        : status === 'error'
          ? { cls: 'danger', dot: '', label: 'Needs attention' }
          : status === 'unavailable'
            ? { cls: 'warn', dot: '', label: 'Status unavailable' }
            : { cls: 'off', dot: '', label: 'Not connected' };
  return (
    <span className={`cn-pill cn-pill-${meta.cls}`}>
      <i className={`cn-dot${meta.dot}`} />
      {meta.label}
    </span>
  );
}

type Notice = { tone: 'ok' | 'danger' | 'info'; text: string; detail?: string };

// ---------- connected account card ----------

function ConnectedCard({
  c,
  now,
  busy,
  confirming,
  onCheck,
  onDisconnect,
  onConfirmChange,
}: {
  c: GmailConnection;
  now: number;
  busy: boolean;
  confirming: boolean;
  onCheck: () => void;
  onDisconnect: () => void;
  onConfirmChange: (open: boolean) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);
  const manageRef = useRef<HTMLButtonElement | null>(null);
  const menuItemRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    menuItemRef.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (menuWrapRef.current !== null && !menuWrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        manageRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  const checking = busy || c.status === 'checking';

  return (
    <section className="cn-card" aria-label={`Gmail — ${c.email}`}>
      <div className="cn-card-head">
        <GmailLogo />
        <div className="cn-who">
          <b>{c.email}</b>
          <span>Gmail</span>
        </div>
        <StatusPill status={c.status} />
      </div>

      {c.status === 'error' && (
        <p className="cn-problem">
          {c.error ??
            'The last health check failed. Google didn’t say why — try a manual check, or reconnect.'}
        </p>
      )}

      {confirming ? (
        <div className="cn-confirm" role="group" aria-label="Confirm disconnect">
          <p>
            Disconnect <b>{c.email}</b>? Fluid loses access to this inbox immediately. Nothing in
            Gmail itself is deleted, and you can reconnect any time.
          </p>
          <div className="cn-actions">
            <button
              type="button"
              className="cn-btn cn-btn-danger"
              onClick={onDisconnect}
              disabled={busy}
            >
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </button>
            <button
              ref={cancelRef}
              type="button"
              className="cn-btn"
              onClick={() => onConfirmChange(false)}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="cn-card-foot">
          <dl className="cn-meta">
            <div className="cn-meta-item">
              <dt>Last checked</dt>
              <dd title={fmtAbs(c.lastCheckedAt)}>{fmtPast(c.lastCheckedAt, now, 'not yet')}</dd>
            </div>
            <div className="cn-meta-item">
              <dt>Next check</dt>
              <dd title={fmtAbs(c.nextCheckAt)}>{fmtFuture(c.nextCheckAt, now)}</dd>
            </div>
          </dl>
          <div className="cn-actions">
            <button type="button" className="cn-btn" onClick={onCheck} disabled={checking}>
              {checking ? 'Checking…' : 'Check now'}
            </button>
            <div className="cn-menu-wrap" ref={menuWrapRef}>
              <button
                ref={manageRef}
                type="button"
                className="cn-btn cn-btn-icon"
                aria-label={`Manage ${c.email}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                  <circle cx="3" cy="8" r="1.4" fill="currentColor" />
                  <circle cx="8" cy="8" r="1.4" fill="currentColor" />
                  <circle cx="13" cy="8" r="1.4" fill="currentColor" />
                </svg>
              </button>
              {menuOpen && (
                <div className="cn-menu" role="menu" aria-label={`Manage ${c.email}`}>
                  <button
                    ref={menuItemRef}
                    type="button"
                    role="menuitem"
                    className="cn-menu-item cn-menu-item-danger"
                    onClick={() => {
                      setMenuOpen(false);
                      onConfirmChange(true);
                    }}
                  >
                    Disconnect…
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------- the page ----------

export function ConnectionsPage({
  d,
  onNavigate,
}: {
  d: Derived;
  onNavigate: (label: string) => void;
}) {
  const [payload, setPayload] = useState<ConnectionsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ConnectionLoadFailure | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async (silent: boolean) => {
    if (!silent) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const data = await api<ConnectionsPayload>('/api/connections');
      setPayload(data);
      setLoadError(null);
      setNow(Date.now());
    } catch (e) {
      if (!silent) setLoadError(connectionLoadFailure(e));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // On arrival: read the OAuth callback params, turn them into a banner,
  // then strip them from the URL without leaving /connections.
  useEffect(() => {
    const url = new URL(window.location.href);
    const gmail = url.searchParams.get('gmail');
    const message = url.searchParams.get('message');
    if (gmail !== null || message !== null) {
      if (gmail === 'connected') {
        setNotice({
          tone: 'ok',
          text: 'Gmail connected. Fluid can now securely reach and verify this inbox.',
          detail: message ?? undefined,
        });
      } else if (gmail === 'error') {
        setNotice({
          tone: 'danger',
          text: 'Google sign-in didn’t complete — nothing was connected.',
          detail: message ?? 'You can try again below.',
        });
      } else if (message !== null) {
        setNotice({ tone: 'info', text: message });
      }
      url.searchParams.delete('gmail');
      url.searchParams.delete('message');
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    }
    void load(false);
  }, [load]);

  // Keep relative times honest, and quietly pick up results of the
  // server's own background checks.
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    const refresh = window.setInterval(() => void load(true), 60_000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(refresh);
    };
  }, [load]);

  const connect = async () => {
    setConnecting(true);
    setActionError(null);
    try {
      const { authorizationUrl } = await api<{ authorizationUrl: string }>(
        '/api/connections/gmail/authorize',
        { method: 'POST' },
      );
      window.location.assign(authorizationUrl);
      // stay in the "opening…" state — the browser is leaving for Google
    } catch (e) {
      setActionError(`Couldn’t start Google sign-in: ${errText(e)}.`);
      setConnecting(false);
    }
  };

  const checkNow = async (id: string) => {
    setBusyId(id);
    setActionError(null);
    try {
      const { connection } = await api<{ connection: GmailConnection }>(
        `/api/connections/${id}/check`,
        { method: 'POST' },
      );
      setPayload((p) =>
        p === null
          ? p
          : { ...p, connections: p.connections.map((c) => (c.id === connection.id ? connection : c)) },
      );
      setNow(Date.now());
    } catch (e) {
      setActionError(`Check failed: ${errText(e)}.`);
    } finally {
      setBusyId(null);
    }
  };

  const disconnect = async (c: GmailConnection) => {
    setBusyId(c.id);
    setActionError(null);
    try {
      await api<void>(`/api/connections/${c.id}`, { method: 'DELETE' });
      setPayload((p) =>
        p === null ? p : { ...p, connections: p.connections.filter((x) => x.id !== c.id) },
      );
      setNotice({
        tone: 'info',
        text: `${c.email} disconnected.`,
        detail: 'Fluid no longer has access to this inbox. Nothing in Gmail itself was changed.',
      });
    } catch (e) {
      setActionError(`Couldn’t disconnect: ${errText(e)}.`);
    } finally {
      setBusyId(null);
      setConfirmId(null);
    }
  };

  const gmailConnections = payload?.connections.filter((c) => c.provider === 'gmail') ?? [];
  const interval = everyPhrase(payload?.healthCheckIntervalMs ?? 300_000);

  return (
    <div className="v v-flow v-zen cn-root">
      <div className="fl-shell">
        <SideNav d={d} active="Connections" onNav={onNavigate} />
        <div className="fl-frame">
          <main className="cn-main">
            <div className="cn-inner">
              <header className="cn-head">
                <h1>Connections</h1>
                <p>External accounts Fluid can reach on this workspace’s behalf.</p>
              </header>

              {notice !== null && (
                <div
                  className={`cn-banner cn-banner-${notice.tone}`}
                  role={notice.tone === 'danger' ? 'alert' : 'status'}
                >
                  <div className="cn-banner-body">
                    <b>{notice.text}</b>
                    {notice.detail !== undefined && <span>{notice.detail}</span>}
                  </div>
                  <button
                    type="button"
                    className="cn-dismiss"
                    onClick={() => setNotice(null)}
                    aria-label="Dismiss message"
                  >
                    ✕
                  </button>
                </div>
              )}

              {actionError !== null && (
                <div className="cn-banner cn-banner-danger" role="alert">
                  <div className="cn-banner-body">
                    <b>{actionError}</b>
                  </div>
                  <button
                    type="button"
                    className="cn-dismiss"
                    onClick={() => setActionError(null)}
                    aria-label="Dismiss error"
                  >
                    ✕
                  </button>
                </div>
              )}

              {loading ? (
                <div className="cn-loading" role="status">
                  <i className="cn-dot cn-dot-breathe" />
                  Checking Gmail connection status…
                </div>
              ) : loadError !== null ? (
                <section
                  className="cn-card"
                  aria-label={`Gmail — ${INTENDED_EMAIL} — status unavailable`}
                >
                  <div className="cn-card-head">
                    <GmailLogo dim />
                    <div className="cn-who">
                      <b>{INTENDED_EMAIL}</b>
                      <span>Gmail</span>
                    </div>
                    <StatusPill status="unavailable" />
                  </div>
                  <p className="cn-problem" role="alert">
                    <b>Fluid’s integration server is unavailable</b> — Gmail itself wasn’t reached,
                    so this page isn’t claiming the inbox is connected or disconnected.{' '}
                    {loadError.message}
                    {loadError.status !== null && !loadError.message.includes('HTTP')
                      ? ` (HTTP ${loadError.status})`
                      : ''}
                  </p>
                  <div className="cn-actions">
                    <button type="button" className="cn-btn" onClick={() => void load(false)}>
                      Try again
                    </button>
                  </div>
                </section>
              ) : payload !== null ? (
                <>
                  {!payload.configured && (
                    <div className="cn-panel cn-panel-warn" role="status">
                      <p className="cn-panel-text">
                        <b>Gmail isn’t set up on the server yet.</b>{' '}
                        {payload.configurationError ??
                          'The server is missing its Google credentials, so connecting is disabled until an administrator adds them.'}
                      </p>
                    </div>
                  )}

                  {gmailConnections.length === 0 ? (
                    <section className="cn-section" aria-labelledby="cn-section-h">
                      <h2 id="cn-section-h" className="cn-section-label">
                        Available
                      </h2>
                      <section className="cn-card" aria-label="Gmail — not connected">
                        <div className="cn-card-head">
                          <GmailLogo dim />
                          <div className="cn-who">
                            <b>Gmail</b>
                            <span>{INTENDED_EMAIL}</span>
                          </div>
                          <StatusPill status="off" />
                        </div>
                        <p className="cn-card-text">
                          Connect the shared inbox through Google sign-in — approve access there and
                          you’ll land back on this page.
                        </p>
                        <div className="cn-actions">
                          <button
                            type="button"
                            className="cn-btn cn-btn-primary"
                            onClick={() => void connect()}
                            disabled={!payload.configured || connecting}
                          >
                            {connecting ? 'Opening Google sign-in…' : 'Connect Gmail'}
                          </button>
                        </div>
                        {!payload.configured && (
                          <p className="cn-hint">
                            Disabled until the server has Google credentials — see the note above.
                          </p>
                        )}
                      </section>
                    </section>
                  ) : (
                    <section className="cn-section" aria-labelledby="cn-section-h">
                      <h2 id="cn-section-h" className="cn-section-label">
                        Connected
                      </h2>
                      {gmailConnections.map((c) => (
                        <ConnectedCard
                          key={c.id}
                          c={c}
                          now={now}
                          busy={busyId === c.id}
                          confirming={confirmId === c.id}
                          onCheck={() => void checkNow(c.id)}
                          onDisconnect={() => void disconnect(c)}
                          onConfirmChange={(open) => setConfirmId(open ? c.id : null)}
                        />
                      ))}
                      <p className="cn-quiet">Automatic health checks {interval}.</p>
                    </section>
                  )}
                </>
              ) : null}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
