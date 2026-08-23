import { useCallback, useEffect, useState } from 'react';
import { Derived } from '../variants/shared';
import { SideNav } from '../variants/kit';
import '../variants/flow.css';
import '../variants/zen.css';
import './connections.css';

/**
 * Connections — where the business grants Fluid access to real accounts.
 * Today that is one shared Gmail inbox. The page talks to the real
 * connections API: it never pretends an account is connected, it explains
 * how the background health checks keep the link alive, and every action
 * (connect / check / disconnect) reports exactly what happened.
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

/** The inbox this workspace is meant to connect. */
const INTENDED_EMAIL = 'info@paintersottawa.com';

// ---------- API ----------

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
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
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

/** "every five minutes" — worded from the interval the server actually returns. */
function everyPhrase(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min <= 1) return 'every minute';
  const words = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  return `every ${words[min - 2] ?? String(min)} minutes`;
}

// ---------- small pieces ----------

/** Letter mark for Gmail — a plain tile, no emoji, no gradient. */
function GmailMark({ dim = false }: { dim?: boolean }) {
  return (
    <span className={`cn-mark${dim ? ' cn-mark-dim' : ''}`} aria-hidden="true">
      M
    </span>
  );
}

function StatusPill({ status }: { status: GmailConnection['status'] | 'off' }) {
  const meta =
    status === 'connected'
      ? { cls: 'ok', dot: '', label: 'Connected' }
      : status === 'checking'
        ? { cls: 'accent', dot: ' cn-dot-breathe', label: 'Checking…' }
        : status === 'error'
          ? { cls: 'danger', dot: '', label: 'Needs attention' }
          : { cls: 'off', dot: '', label: 'Not connected' };
  return (
    <span className={`cn-pill cn-pill-${meta.cls}`}>
      <i className={`cn-dot${meta.dot}`} />
      {meta.label}
    </span>
  );
}

function Fact({ label, value, abs }: { label: string; value: string; abs?: string }) {
  return (
    <div className="cn-fact">
      <dt>{label}</dt>
      <dd title={abs}>{value}</dd>
    </div>
  );
}

type Notice = { tone: 'ok' | 'danger' | 'info'; text: string; detail?: string };

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
  const [loadError, setLoadError] = useState<string | null>(null);
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
      if (!silent) setLoadError(errText(e));
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
                <p>
                  Accounts Fluid is authorized to read. Right now that means the shared company
                  inbox.
                </p>
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
                  Checking connection status…
                </div>
              ) : loadError !== null ? (
                <div className="cn-panel" role="alert">
                  <p className="cn-panel-text">
                    Couldn’t load connection status — {loadError}. Nothing shown here would be
                    trustworthy, so the page is holding back instead of guessing.
                  </p>
                  <button type="button" className="cn-btn" onClick={() => void load(false)}>
                    Try again
                  </button>
                </div>
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
                    <section className="cn-card" aria-label="Gmail — not connected">
                      <div className="cn-card-head">
                        <GmailMark dim />
                        <div className="cn-who">
                          <b>{INTENDED_EMAIL}</b>
                          <span>Gmail · shared company inbox</span>
                        </div>
                        <StatusPill status="off" />
                      </div>
                      <p className="cn-card-text">
                        Fluid doesn’t have access to this inbox yet. Connecting opens Google’s
                        sign-in for <b>{INTENDED_EMAIL}</b> — approve read access there and you’ll
                        land back on this page.
                      </p>
                      <div className="cn-btns">
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
                  ) : (
                    gmailConnections.map((c) => (
                      <section key={c.id} className="cn-card" aria-label={`Gmail — ${c.email}`}>
                        <div className="cn-card-head">
                          <GmailMark />
                          <div className="cn-who">
                            <b>{c.email}</b>
                            <span>Gmail · shared company inbox</span>
                          </div>
                          <StatusPill status={c.status} />
                        </div>

                        {c.status === 'error' && (
                          <p className="cn-problem">
                            {c.error ??
                              'The last health check failed. Google didn’t say why — try a manual check, or reconnect.'}
                          </p>
                        )}

                        <dl className="cn-facts">
                          <Fact
                            label="Last checked"
                            value={fmtPast(c.lastCheckedAt, now, 'not yet')}
                            abs={fmtAbs(c.lastCheckedAt)}
                          />
                          <Fact
                            label="Last healthy"
                            value={fmtPast(c.lastHealthyAt, now, 'never')}
                            abs={fmtAbs(c.lastHealthyAt)}
                          />
                          <Fact
                            label="Next check"
                            value={fmtFuture(c.nextCheckAt, now)}
                            abs={fmtAbs(c.nextCheckAt)}
                          />
                          <Fact
                            label="Connected"
                            value={fmtPast(c.createdAt, now, '—')}
                            abs={fmtAbs(c.createdAt)}
                          />
                        </dl>

                        {confirmId === c.id ? (
                          <div className="cn-confirm" role="group" aria-label="Confirm disconnect">
                            <p>
                              Disconnect <b>{c.email}</b>? Fluid loses access to this inbox
                              immediately. Nothing in Gmail itself is deleted, and you can
                              reconnect any time.
                            </p>
                            <div className="cn-btns">
                              <button
                                type="button"
                                className="cn-btn cn-btn-danger"
                                onClick={() => void disconnect(c)}
                                disabled={busyId === c.id}
                              >
                                {busyId === c.id ? 'Disconnecting…' : 'Yes, disconnect'}
                              </button>
                              <button
                                type="button"
                                className="cn-btn"
                                onClick={() => setConfirmId(null)}
                                disabled={busyId === c.id}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="cn-btns">
                            <button
                              type="button"
                              className="cn-btn cn-btn-primary"
                              onClick={() => void checkNow(c.id)}
                              disabled={busyId === c.id || c.status === 'checking'}
                            >
                              {busyId === c.id || c.status === 'checking' ? 'Checking…' : 'Check now'}
                            </button>
                            <button
                              type="button"
                              className="cn-btn cn-btn-quiet-danger"
                              onClick={() => setConfirmId(c.id)}
                            >
                              Disconnect…
                            </button>
                          </div>
                        )}
                      </section>
                    ))
                  )}

                  <section className="cn-explain" aria-labelledby="cn-explain-h">
                    <h2 id="cn-explain-h">How the connection stays healthy</h2>
                    <ul>
                      <li>
                        <b>Background checks {interval}.</b> Fluid quietly confirms it can still
                        reach the inbox — no mail is sent or moved. “Last checked” is the most
                        recent attempt, “last healthy” is the most recent one that succeeded, and
                        “next check” is when the following attempt is due.
                      </li>
                      <li>
                        <b>It works while you’re away.</b> When you connect, Google issues Fluid a
                        refresh token that’s stored on the server. The connection survives
                        restarts and doesn’t need this page open or another sign-in — it keeps
                        working until you disconnect or Google revokes access.
                      </li>
                      <li>
                        <b>If a check fails</b>, the account flips to “needs attention” with
                        Google’s reason shown on the card. A manual “Check now” often clears a
                        temporary blip; if it doesn’t, disconnect and connect again to refresh the
                        grant.
                      </li>
                    </ul>
                  </section>
                </>
              ) : null}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
