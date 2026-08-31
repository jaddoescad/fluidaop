import { useEffect, useState } from 'react';
import { type HermesStatus } from '../agents/hermes';
import { APP_ROUTES } from '../app/routes';

const NAV_ITEMS = APP_ROUTES.map((route) => ({ icon: route.icon, label: route.id }));

/** Connections that authenticate but have stopped delivering data.
 *
 * Polled here rather than passed down, so the warning is visible from every
 * page without threading state through each one. A pipe going quiet is the
 * failure mode that otherwise goes unnoticed until someone looks. */
function useConnectionAlert(): string | undefined {
  const [alert, setAlert] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const response = await fetch('/api/connections', { headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          connections?: Array<{ health?: { state?: string; reason?: string | null } }>;
        };
        const broken = (payload.connections ?? []).filter(
          (connection) => connection.health?.state === 'degraded' || connection.health?.state === 'attention',
        );
        if (cancelled) return;
        setAlert(broken.length === 0
          ? undefined
          : broken.map((connection) => connection.health?.reason).filter(Boolean).join(' ') || 'A connection needs attention');
      } catch {
        // A failed poll is not itself an alert; the page shows connection errors.
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  return alert;
}

export function SideNav({ active = 'Board', onNav, alerts }: {
  active?: string;
  onNav?: (label: string) => void;
  /** Pages needing attention, e.g. a connection that has stopped delivering. */
  alerts?: Record<string, string | undefined>;
}) {
  const connectionAlert = useConnectionAlert();
  const resolved: Record<string, string | undefined> = { Connections: connectionAlert, ...alerts };
  const item = (entry: { icon: string; label: string }) => {
    const selected = entry.label === active;
    const alert = resolved[entry.label];
    return (
      <button
        key={entry.label}
        type="button"
        className={`fl-nav-item${selected ? ' on' : ''}`}
        onClick={onNav === undefined ? undefined : () => onNav(entry.label)}
        disabled={onNav === undefined && !selected}
        aria-current={selected ? 'page' : undefined}
        title={alert}
      >
        <span className="fl-nav-ico" aria-hidden="true">{entry.icon}</span>
        {entry.label}
        {alert !== undefined && <span className="fl-nav-alert" aria-label={alert} />}
      </button>
    );
  };

  return (
    <nav className="fl-nav" aria-label="Primary">
      <div className="fl-nav-brand">
        <span className="fl-mark" />
        <div className="fl-nav-names">
          <b className="fl-nav-logo">FLUID</b>
          <span className="fl-nav-co">Ottawa Painters</span>
        </div>
      </div>
      {NAV_ITEMS.map(item)}
      <div className="fl-nav-gap" />
    </nav>
  );
}

export function KitHeader({ hermesStatus, hermesError = null }: {
  hermesStatus?: HermesStatus | null;
  hermesError?: string | null;
}) {
  const currentStatus = hermesStatus ?? null;
  const hermesState = hermesError !== null
    ? currentStatus === null ? 'unavailable' : 'degraded'
    : currentStatus === null
      ? 'checking'
      : currentStatus.connected
        ? 'online'
        : currentStatus.gatewayState === 'running'
          ? 'degraded'
          : 'offline';
  const hermesTitle = hermesError !== null
    ? `Hermes is ${hermesState}: ${hermesError}`
    : currentStatus === null
      ? 'Checking the Hermes gateway and scheduler'
      : hermesState === 'online'
        ? 'Hermes gateway and scheduler are available'
        : `Hermes gateway is ${currentStatus.gatewayState}`;

  return (
    <header className="fl-top">
      <div className="fl-workspace-title">
        <span>Fluid</span>
        <b>Operations workspace</b>
      </div>
      <span className="fl-hspace" />
      {hermesStatus !== undefined && (
        <span className="fl-hermes" title={hermesTitle}>
          <span className={`sim-dot hermes-dot-${hermesState}`} />
          Hermes · {hermesState}
        </span>
      )}
      <div className="fl-user" title="Ottawa Painters manager">
        <span className="avatar">JD</span>
        <span className="fl-user-name">Jad</span>
      </div>
    </header>
  );
}
