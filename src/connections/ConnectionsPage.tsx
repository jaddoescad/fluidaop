import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
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

interface QuoPhoneNumber {
  id: string;
  e164: string;
  label: string | null;
}

interface QuoConnection {
  id: string;
  provider: 'quo';
  phoneNumbers: QuoPhoneNumber[];
  selectedPhoneNumberIds: string[];
  status: 'connected' | 'error' | 'checking';
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastHealthyAt: string | null;
  nextCheckAt: string | null;
  error: string | null;
  webhook: {
    state: 'receiving' | 'ready' | 'pending';
    url: string;
    lastEventAt: string | null;
    signingSecretConfigured: boolean;
  };
}

type Connection = GmailConnection | QuoConnection;

interface ConnectionsPayload {
  connections: Connection[];
  healthCheckIntervalMs: number;
  configured?: boolean;
  gmail: { configured: boolean; configurationError?: string };
  quo: { configured: boolean; configurationError?: string };
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
          ? `Fluid's connections API returned HTTP ${e.status}.`
          : e.message,
    };
  }
  return {
    status: null,
    message: "Fluid's connections API could not be reached.",
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

function fmtPhone(phone: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone;
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

function QuoLogo({ dim = false }: { dim?: boolean }) {
  return (
    <span className={`cn-logo cn-logo-quo${dim ? ' cn-logo-dim' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="20" height="20" focusable="false">
        <circle cx="9" cy="12" r="6.2" fill="#fff" />
        <circle cx="15" cy="12" r="6.2" fill="#fff" opacity="0.82" />
      </svg>
    </span>
  );
}

function StatusPill({
  status,
}: {
  status: Connection['status'] | 'off' | 'unavailable';
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

function QuoWebhookSection({ webhook, now }: { webhook: QuoConnection['webhook']; now: number }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  if (webhook.state === 'receiving') {
    return (
      <p className="cn-manage-ok">
        <i className="cn-dot" />
        Receiving events
        {webhook.lastEventAt !== null && <span> · last event {fmtPast(webhook.lastEventAt, now, 'never')}</span>}
      </p>
    );
  }
  if (webhook.state === 'ready') {
    return (
      <p className="cn-manage-ok">
        <i className="cn-dot" />
        Webhook ready <span> · waiting for the first event</span>
      </p>
    );
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(webhook.url);
      setCopyError(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      setCopyError(true);
    }
  };
  return (
    <>
      <p className="cn-manage-note">Add this URL as the webhook in Quo to start receiving calls and texts.</p>
      <div className="cn-webhook-url-row">
        <code className="cn-webhook-url">{webhook.url || 'Supabase webhook URL unavailable'}</code>
        {webhook.url !== '' && (
          <button type="button" className="cn-btn cn-btn-sm" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
        <span aria-live="polite" className="cn-sr">{copied ? 'Copied to clipboard' : ''}</span>
      </div>
      {copyError && <p className="cn-hint">Couldn’t copy — select the URL and copy it manually.</p>}
    </>
  );
}

type ImportKind = 'messages' | 'calls';
type ImportFileState =
  | { phase: 'idle' }
  | { phase: 'selected'; file: File }
  | { phase: 'uploading'; file: File }
  | { phase: 'done'; file: File; imported: number; skipped: number }
  | { phase: 'error'; file: File; message: string };

const IMPORT_ROWS: { kind: ImportKind; title: string; hint: string }[] = [
  { kind: 'messages', title: 'Message logs', hint: 'CSV exported from Quo → Messages' },
  { kind: 'calls', title: 'Call logs', hint: 'CSV exported from Quo → Calls' },
];

function QuoImportPanel({ connectionId }: { connectionId: string }) {
  const [rows, setRows] = useState<Record<ImportKind, ImportFileState>>({
    messages: { phase: 'idle' }, calls: { phase: 'idle' },
  });
  const pickFile = (kind: ImportKind, file: File | null) => {
    setRows((current) => ({
      ...current,
      [kind]: file === null ? { phase: 'idle' } : { phase: 'selected', file },
    }));
  };
  const upload = async (kind: ImportKind) => {
    const selected = rows[kind];
    if (selected.phase !== 'selected' && selected.phase !== 'error') return;
    const file = selected.file;
    setRows((current) => ({ ...current, [kind]: { phase: 'uploading', file } }));
    try {
      const text = await file.text();
      const result = await api<{ imported: number; skipped: number }>(
        `/api/connections/quo/${encodeURIComponent(connectionId)}/import?kind=${kind}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'x-fluid-filename': encodeURIComponent(file.name),
          },
          body: text,
        },
      );
      setRows((current) => ({
        ...current,
        [kind]: { phase: 'done', file, imported: result.imported, skipped: result.skipped },
      }));
    } catch (error) {
      setRows((current) => ({
        ...current,
        [kind]: { phase: 'error', file, message: errText(error) },
      }));
    }
  };
  return (
    <div className="cn-import">
      <p className="cn-manage-note">Upload CSV exports from Quo. Each file imports independently.</p>
      {IMPORT_ROWS.map(({ kind, title, hint }) => {
        const state = rows[kind];
        const inputId = `cn-import-${connectionId}-${kind}`;
        return (
          <div className="cn-import-row" key={kind}>
            <div className="cn-import-row-head">
              <label htmlFor={inputId} className="cn-import-label">{title}</label>
              <span className="cn-import-hint" id={`${inputId}-hint`}>{hint}</span>
            </div>
            <div className="cn-import-row-body">
              <input
                id={inputId}
                type="file"
                accept=".csv,text/csv"
                aria-describedby={`${inputId}-hint`}
                className="cn-import-input"
                disabled={state.phase === 'uploading'}
                onChange={(event) => pickFile(kind, event.target.files?.[0] ?? null)}
              />
              {(state.phase === 'selected' || state.phase === 'error') && (
                <button type="button" className="cn-btn cn-btn-sm cn-btn-primary" onClick={() => void upload(kind)}>
                  Upload
                </button>
              )}
            </div>
            {state.phase === 'uploading' && (
              <p className="cn-import-status cn-import-status-busy" role="status">
                <i className="cn-dot cn-dot-breathe" /> Uploading {state.file.name}…
              </p>
            )}
            {state.phase === 'done' && (
              <p className="cn-import-status cn-import-status-ok" role="status">
                {state.imported} imported{state.skipped > 0 ? `, ${state.skipped} skipped` : ''} from {state.file.name}
              </p>
            )}
            {state.phase === 'error' && (
              <p className="cn-import-status cn-import-status-err" role="alert">
                {state.file.name} failed: {state.message}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ConnectedQuoCard({
  c,
  now,
  busy,
  confirming,
  manageOpen,
  onCheck,
  onDisconnect,
  onConfirmChange,
  onManageChange,
  onScopeSave,
}: {
  c: QuoConnection;
  now: number;
  busy: boolean;
  confirming: boolean;
  manageOpen: boolean;
  onCheck: () => void;
  onDisconnect: () => void;
  onConfirmChange: (open: boolean) => void;
  onManageChange: (open: boolean) => void;
  onScopeSave: (phoneNumberIds: string[]) => Promise<void>;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [scopeDraft, setScopeDraft] = useState<string[]>(c.selectedPhoneNumberIds);
  const [scopeError, setScopeError] = useState<string | null>(null);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);
  useEffect(() => {
    setScopeDraft(c.selectedPhoneNumberIds);
    setScopeError(null);
  }, [c.selectedPhoneNumberIds]);
  const checking = busy || c.status === 'checking';
  const selectedNumbers = c.phoneNumbers.filter((number) => c.selectedPhoneNumberIds.includes(number.id));
  const selectedCount = selectedNumbers.length;
  const lineSummary = selectedCount === 0
    ? 'Capture off'
    : selectedCount === 1
      ? selectedNumbers[0]?.label || (selectedNumbers[0] ? fmtPhone(selectedNumbers[0].e164) : '1 phone line')
      : `${selectedCount} phone lines`;
  const scopeChanged = [...scopeDraft].sort().join(',') !== [...c.selectedPhoneNumberIds].sort().join(',');
  const panelId = `cn-quo-manage-${c.id}`;
  const toggleScope = (id: string) => {
    setScopeDraft((current) => current.includes(id)
      ? current.filter((currentId) => currentId !== id)
      : [...current, id]);
    setScopeError(null);
  };
  const saveScope = async () => {
    setScopeError(null);
    try {
      await onScopeSave(scopeDraft);
    } catch (error) {
      setScopeError(errText(error));
    }
  };
  return (
    <section className="cn-card" aria-label={`Quo — ${lineSummary}`}>
      <div className="cn-card-head">
        <QuoLogo />
        <div className="cn-who">
          <b>Quo</b>
          <span>Business phone &amp; SMS</span>
        </div>
        <StatusPill status={c.status} />
      </div>
      <div className="cn-quo-summary">
        <span>{lineSummary}</span>
        {selectedCount === 0 ? (
          <button
            type="button"
            className="cn-cue"
            aria-expanded={manageOpen}
            aria-controls={panelId}
            onClick={() => onManageChange(true)}
          >
            <i className="cn-dot" /> Choose a phone line
          </button>
        ) : c.webhook.state === 'receiving' ? (
          <span className="cn-quo-live">
            <i className="cn-dot" /> Receiving events
          </span>
        ) : c.webhook.state === 'ready' ? (
          <span className="cn-quo-live">
            <i className="cn-dot" /> Webhook ready
          </span>
        ) : (
          <button
            type="button"
            className="cn-cue"
            aria-expanded={manageOpen}
            aria-controls={panelId}
            onClick={() => onManageChange(true)}
          >
            <i className="cn-dot" /> Finish webhook setup
          </button>
        )}
      </div>
      {c.status === 'error' && (
        <p className="cn-problem">{c.error ?? 'The last health check failed. Try a manual check, or reconnect.'}</p>
      )}
      {confirming ? (
        <div className="cn-confirm" role="group" aria-label="Confirm disconnect">
          <p>Disconnect <b>Quo</b>? Fluid loses access to this workspace’s calls and texts immediately. Nothing in Quo itself is deleted.</p>
          <div className="cn-actions">
            <button type="button" className="cn-btn cn-btn-danger" onClick={onDisconnect} disabled={busy}>
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </button>
            <button ref={cancelRef} type="button" className="cn-btn" onClick={() => onConfirmChange(false)} disabled={busy}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <div className="cn-card-foot">
            <dl className="cn-meta">
              <div className="cn-meta-item"><dt>Last checked</dt><dd title={fmtAbs(c.lastCheckedAt)}>{fmtPast(c.lastCheckedAt, now, 'not yet')}</dd></div>
              <div className="cn-meta-item"><dt>Next check</dt><dd title={fmtAbs(c.nextCheckAt)}>{fmtFuture(c.nextCheckAt, now)}</dd></div>
            </dl>
            <div className="cn-actions">
              <button type="button" className="cn-btn" onClick={onCheck} disabled={checking}>{checking ? 'Checking…' : 'Check now'}</button>
              <button
                type="button"
                className="cn-btn"
                aria-expanded={manageOpen}
                aria-controls={panelId}
                onClick={() => onManageChange(!manageOpen)}
              >
                Manage
                <svg className="cn-chev" viewBox="0 0 10 10" width="9" height="9" aria-hidden="true" focusable="false">
                  <path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
          {manageOpen && (
            <div id={panelId} className="cn-manage">
              <section aria-label="Phone lines">
                <h3 className="cn-manage-label">Captured phone lines</h3>
                <p className="cn-manage-note">Only checked lines can enter Activity. Unchecked lines are ignored during imports and webhook delivery.</p>
                <div className="cn-scope-options" role="group" aria-label="Choose Quo phone lines to capture">
                  {c.phoneNumbers.map((number) => (
                    <label className="cn-scope-option" key={number.id}>
                      <input
                        type="checkbox"
                        checked={scopeDraft.includes(number.id)}
                        disabled={busy}
                        onChange={() => toggleScope(number.id)}
                      />
                      <span className="cn-scope-copy">
                        <b>{number.label || 'Unnamed line'}</b>
                        <span>{fmtPhone(number.e164)}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="cn-scope-actions">
                  <button type="button" className="cn-btn cn-btn-sm cn-btn-primary" disabled={busy || !scopeChanged} onClick={() => void saveScope()}>
                    {busy ? 'Saving…' : 'Save phone lines'}
                  </button>
                  <span>{scopeDraft.length === 0 ? 'No calls or texts will be captured.' : `${scopeDraft.length} selected`}</span>
                </div>
                {scopeError !== null && <p className="cn-import-status cn-import-status-err" role="alert">{scopeError}</p>}
              </section>
              {selectedCount > 0 && (
                <section aria-label="Webhook">
                  <h3 className="cn-manage-label">Webhook</h3>
                  <QuoWebhookSection webhook={c.webhook} now={now} />
                </section>
              )}
              {selectedCount > 0 && (
                <section aria-label="Import history">
                  <h3 className="cn-manage-label">Import history</h3>
                  <QuoImportPanel connectionId={c.id} />
                </section>
              )}
              <section aria-label="Disconnect">
                <button type="button" className="cn-btn cn-btn-sm cn-btn-danger" onClick={() => onConfirmChange(true)}>
                  Disconnect…
                </button>
              </section>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------- the page ----------

export function ConnectionsPage({
  d,
  onNavigate,
  header,
}: {
  d: Derived;
  onNavigate: (label: string) => void;
  header: ReactNode;
}) {
  const [payload, setPayload] = useState<ConnectionsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ConnectionLoadFailure | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [quoConnecting, setQuoConnecting] = useState(false);
  const [quoApiKey, setQuoApiKey] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [manageOpenId, setManageOpenId] = useState<string | null>(null);
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

  const connectQuo = async () => {
    setQuoConnecting(true);
    setActionError(null);
    try {
      const { connection } = await api<{ connection: QuoConnection }>('/api/connections/quo/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: quoApiKey }),
      });
      setQuoApiKey('');
      setPayload((current) => current === null
        ? current
        : { ...current, connections: [...current.connections.filter((item) => item.provider !== 'quo'), connection] });
      setManageOpenId(connection.id);
      setNotice({ tone: 'ok', text: 'Quo connected.', detail: 'Choose which phone line Fluid is allowed to capture.' });
    } catch (error) {
      setActionError(`Couldn’t connect Quo: ${errText(error)}.`);
    } finally {
      setQuoConnecting(false);
    }
  };

  const saveQuoScope = async (c: QuoConnection, phoneNumberIds: string[]) => {
    setBusyId(c.id);
    setActionError(null);
    try {
      const { connection } = await api<{ connection: QuoConnection }>(
        `/api/connections/quo/${encodeURIComponent(c.id)}/scope`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phoneNumberIds }),
        },
      );
      setPayload((current) => current === null
        ? current
        : { ...current, connections: current.connections.map((item) => item.id === connection.id ? connection : item) });
      setNotice({
        tone: 'ok',
        text: phoneNumberIds.length === 0 ? 'Quo capture is off.' : 'Quo phone-line scope saved.',
        detail: phoneNumberIds.length === 0
          ? 'No Quo calls or texts will enter Activity.'
          : `Only ${phoneNumberIds.length} selected phone line${phoneNumberIds.length === 1 ? '' : 's'} can enter Activity.`,
      });
    } catch (error) {
      setActionError(`Couldn’t save Quo phone lines: ${errText(error)}.`);
      throw error;
    } finally {
      setBusyId(null);
    }
  };

  const checkNow = async (id: string) => {
    setBusyId(id);
    setActionError(null);
    try {
      const { connection } = await api<{ connection: Connection }>(
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

  const disconnect = async (c: Connection) => {
    setBusyId(c.id);
    setActionError(null);
    try {
      await api<void>(`/api/connections/${c.id}`, { method: 'DELETE' });
      setPayload((p) =>
        p === null ? p : { ...p, connections: p.connections.filter((x) => x.id !== c.id) },
      );
      setNotice({
        tone: 'info',
        text: `${c.provider === 'gmail' ? c.email : 'Quo'} disconnected.`,
        detail: c.provider === 'gmail'
          ? 'Fluid no longer has access to this inbox. Nothing in Gmail itself was changed.'
          : 'Fluid no longer has access to this workspace’s calls and texts. Nothing in Quo itself was changed.',
      });
    } catch (e) {
      setActionError(`Couldn’t disconnect: ${errText(e)}.`);
    } finally {
      setBusyId(null);
      setConfirmId(null);
    }
  };

  const gmailConnections = payload?.connections.filter((c) => c.provider === 'gmail') ?? [];
  const quoConnections = payload?.connections.filter((c) => c.provider === 'quo') ?? [];
  const anyAvailable = gmailConnections.length === 0 || quoConnections.length === 0;
  const anyConnected = gmailConnections.length > 0 || quoConnections.length > 0;
  const interval = everyPhrase(payload?.healthCheckIntervalMs ?? 300_000);

  return (
    <div className="v v-flow v-zen cn-root">
      <div className="fl-shell">
        <SideNav d={d} active="Connections" onNav={onNavigate} />
        <div className="fl-frame">
          {header}
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
                  Checking connection status…
                </div>
              ) : loadError !== null ? (
                <section className="cn-card" aria-label="Connections — status unavailable">
                  <div className="cn-card-head">
                    <QuoLogo dim />
                    <div className="cn-who">
                      <b>Connections</b>
                      <span>Gmail &amp; Quo</span>
                    </div>
                    <StatusPill status="unavailable" />
                  </div>
                  <p className="cn-problem" role="alert">
                    <b>Fluid’s integration server is unavailable.</b>{' '}
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
                  {(!payload.gmail.configured || !payload.quo.configured) && (
                    <div className="cn-panel cn-panel-warn" role="status">
                      {!payload.gmail.configured && <p className="cn-panel-text"><b>Gmail isn’t set up on the server yet.</b> {payload.gmail.configurationError ?? 'Add the Google credentials to the server.'}</p>}
                      {!payload.quo.configured && <p className="cn-panel-text"><b>Quo isn’t set up on the server yet.</b> {payload.quo.configurationError ?? 'Add connection encryption to the server.'}</p>}
                    </div>
                  )}

                  {anyAvailable && (
                    <section className="cn-section" aria-labelledby="cn-available-h">
                      <h2 id="cn-available-h" className="cn-section-label">Available</h2>
                      {gmailConnections.length === 0 && <section className="cn-card" aria-label="Gmail — not connected">
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
                            disabled={!payload.gmail.configured || connecting}
                          >
                            {connecting ? 'Opening Google sign-in…' : 'Connect Gmail'}
                          </button>
                        </div>
                        {!payload.gmail.configured && (
                          <p className="cn-hint">
                            Disabled until the server has Google credentials — see the note above.
                          </p>
                        )}
                      </section>}
                      {quoConnections.length === 0 && <section className="cn-card" aria-label="Quo — not connected">
                        <div className="cn-card-head">
                          <QuoLogo dim />
                          <div className="cn-who"><b>Quo</b><span>Business phone &amp; SMS</span></div>
                          <StatusPill status="off" />
                        </div>
                        <p className="cn-card-text">Bring the business phone into Fluid — calls and texts, one workspace.</p>
                        <form
                          className="cn-connect-row"
                          onSubmit={(event) => {
                            event.preventDefault();
                            if (payload.quo.configured && !quoConnecting && quoApiKey.trim() !== '') void connectQuo();
                          }}
                        >
                          <label htmlFor="quo-api-key" className="cn-sr">Quo API key</label>
                          <input id="quo-api-key" type="password" autoComplete="off" spellCheck={false} className="cn-key-input" placeholder="Quo API key" value={quoApiKey} onChange={(event) => setQuoApiKey(event.target.value)} disabled={!payload.quo.configured || quoConnecting} />
                          <button type="submit" className="cn-btn cn-btn-primary" disabled={!payload.quo.configured || quoConnecting || quoApiKey.trim() === ''}>
                            {quoConnecting ? 'Connecting…' : 'Connect'}
                          </button>
                        </form>
                        <p className="cn-keynote">
                          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false">
                            <rect x="2.2" y="5.2" width="7.6" height="5.3" rx="1.4" fill="currentColor" />
                            <path d="M4 5V3.8a2 2 0 0 1 4 0V5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                          </svg>
                          Stored encrypted on the server
                        </p>
                      </section>}
                    </section>
                  )}
                  {anyConnected && (
                    <section className="cn-section" aria-labelledby="cn-connected-h">
                      <h2 id="cn-connected-h" className="cn-section-label">Connected</h2>
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
                      {quoConnections.map((c) => (
                        <ConnectedQuoCard
                          key={c.id}
                          c={c}
                          now={now}
                          busy={busyId === c.id}
                          confirming={confirmId === c.id}
                          manageOpen={manageOpenId === c.id}
                          onCheck={() => void checkNow(c.id)}
                          onDisconnect={() => void disconnect(c)}
                          onConfirmChange={(open) => setConfirmId(open ? c.id : null)}
                          onManageChange={(open) => setManageOpenId(open ? c.id : null)}
                          onScopeSave={(phoneNumberIds) => saveQuoScope(c, phoneNumberIds)}
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
