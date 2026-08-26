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
  { icon: '📊', label: 'Insights' },
] as const;

const NAV_FOOT = [
  { icon: '⚙️', label: 'Settings' },
  { icon: '💬', label: 'Help & feedback' },
] as const;

const LIVE_PAGES = new Set(['Board', 'Agents', 'Skills', 'Actions', 'Activity', 'Labels', 'Schedules', 'Connections', 'Contacts']);

export function SideNav({ active = 'Board', onNav }: {
  active?: string;
  onNav?: (label: string) => void;
}) {
  const item = (entry: { icon: string; label: string }) => {
    const selected = entry.label === active;
    const live = onNav !== undefined && LIVE_PAGES.has(entry.label);
    return (
      <button
        key={entry.label}
        type="button"
        className={`fl-nav-item${selected ? ' on' : ''}`}
        onClick={live ? () => onNav(entry.label) : undefined}
        aria-current={selected ? 'page' : undefined}
        title={live || selected ? undefined : `${entry.label} is not available yet`}
      >
        <span className="fl-nav-ico" aria-hidden="true">{entry.icon}</span>
        {entry.label}
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
