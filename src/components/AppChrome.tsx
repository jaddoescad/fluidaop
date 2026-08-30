import { useEffect, useState } from 'react';
import { type HermesStatus } from '../agents/hermes';

const NAV_MAIN = [
  { icon: '📡', label: 'Board' },
  { icon: '🤖', label: 'Agents' },
  { icon: '🧩', label: 'Skills' },
  { icon: '✓', label: 'Actions' },
  { icon: '⚡', label: 'Activity' },
  { icon: '🏷️', label: 'Labels' },
  { icon: '◷', label: 'Schedules' },
  { icon: '🔌', label: 'Connections' },
  { icon: '👥', label: 'Contacts' },
  { icon: '🧑‍🔧', label: 'Employees' },
  { icon: '📊', label: 'Insights' },
] as const;

const NAV_FOOT = [
  { icon: '⚙️', label: 'Settings' },
  { icon: '💬', label: 'Help & feedback' },
] as const;

const LIVE_PAGES = new Set(['Board', 'Agents', 'Skills', 'Actions', 'Activity', 'Labels', 'Schedules', 'Connections', 'Contacts', 'Employees']);

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
    const live = onNav !== undefined && LIVE_PAGES.has(entry.label);
    const alert = resolved[entry.label];
    return (
      <button
        key={entry.label}
        type="button"
        className={`fl-nav-item${selected ? ' on' : ''}`}
        onClick={live ? () => onNav(entry.label) : undefined}
        aria-current={selected ? 'page' : undefined}
        title={alert ?? (live || selected ? undefined : `${entry.label} is not available yet`)}
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
      {NAV_MAIN.map(item)}
      <div className="fl-nav-gap" />
      <div className="fl-nav-foot">{NAV_FOOT.map(item)}</div>
    </nav>
  );
}

export function KitHeader({ hermesStatus, hermesError }: {
  hermesStatus: HermesStatus | null;
  hermesError: string | null;
}) {
  const hermesState = hermesError !== null
    ? hermesStatus === null ? 'unavailable' : 'degraded'
    : hermesStatus === null
      ? 'checking'
      : hermesStatus.connected
        ? 'online'
        : hermesStatus.gatewayState === 'running'
          ? 'degraded'
          : 'offline';
  const hermesTitle = hermesError !== null
    ? `Hermes is ${hermesState}: ${hermesError}`
    : hermesStatus === null
      ? 'Checking the Hermes gateway and scheduler'
      : hermesState === 'online'
        ? 'Hermes gateway and scheduler are available'
        : `Hermes gateway is ${hermesStatus.gatewayState}`;

  return (
    <header className="fl-top">
      <div className="fl-workspace-title">
        <span>Fluid</span>
        <b>Operations workspace</b>
      </div>
      <span className="fl-hspace" />
      <span className="fl-hermes" title={hermesTitle}>
        <span className={`sim-dot hermes-dot-${hermesState}`} />
        Hermes · {hermesState}
      </span>
      <div className="fl-user" title="Ottawa Painters manager">
        <span className="avatar">JD</span>
        <span className="fl-user-name">Jad</span>
      </div>
    </header>
  );
}
