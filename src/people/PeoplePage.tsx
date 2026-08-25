import { useCallback, useEffect, useState } from 'react';
import { Derived } from '../variants/shared';
import { SideNav } from '../variants/kit';
import '../variants/flow.css';
import '../variants/zen.css';
import './people.css';

const PAGE_SIZE = 30;

type PersonRole = 'customer' | 'employee' | 'painter';

interface PersonRow {
  id: string;
  displayName: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  status: 'active' | 'archived';
  roles: string[];
  sourceSystem: string | null;
  sourceRecordId: string | null;
  lastSyncedAt: string | null;
  linkedSignalCount: number;
  lastSignalAt: string | null;
}

interface PeoplePayload {
  people: PersonRow[];
  count: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  role: PersonRole;
}

interface SyncStatus {
  sourceSystem: string;
  sourceCustomers: number;
  syncedCustomers: number;
  pendingCustomers: number;
  linkedActivities: number;
  needsSync: boolean;
  checkedAt: string;
  lastRun: {
    status: 'running' | 'succeeded' | 'failed' | 'skipped';
    error: string | null;
    finishedAt: string | null;
  } | null;
}

const sections: Array<{ key: PersonRole; label: string; detail: string }> = [
  { key: 'customer', label: 'Customers', detail: 'Ottawa Painters contacts' },
  { key: 'employee', label: 'Employees', detail: 'Not synced yet' },
  { key: 'painter', label: 'Painters', detail: 'Not synced yet' },
];

async function api<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload !== null && typeof payload === 'object' && 'error' in payload &&
      typeof (payload as { error: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : `the server answered HTTP ${response.status}`;
    throw new Error(detail);
  }
  return payload as T;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return `${words[0]?.[0] ?? ''}${words.length > 1 ? words[words.length - 1]?.[0] ?? '' : ''}`.toUpperCase();
}

function relativeTime(value: string | null): string {
  if (value === null) return 'No linked signals';
  const time = Date.parse(value);
  if (Number.isNaN(time)) return 'Unknown time';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function PeoplePage({ d, onNavigate }: { d: Derived; onNavigate: (label: string) => void }) {
  const [role, setRole] = useState<PersonRole>('customer');
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [count, setCount] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextRole: PersonRole, offset = 0, append = false) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const payload = await api<PeoplePayload>(
        `/api/people?role=${encodeURIComponent(nextRole)}&limit=${PAGE_SIZE}&offset=${offset}`,
      );
      setPeople((current) => append ? [...current, ...payload.people] : payload.people);
      setCount(payload.count);
      setNextOffset(payload.nextOffset);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (append) setLoadingMore(false);
      else setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(role);
  }, [load, role]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const next = await api<SyncStatus>('/api/people/sync-status');
        if (active) setStatus(next);
      } catch {
        if (active) setStatus(null);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="v v-flow v-zen pp-root">
      <div className="fl-shell">
        <SideNav d={d} active="People" onNav={onNavigate} />
        <div className="fl-frame">
          <main className="pp-main">
            <div className="pp-inner">
              <header className="pp-head">
                <div>
                  <h1>People</h1>
                  <p>Canonical people connected to signals, roles, and source records.</p>
                </div>
                <div className={`pp-sync${status?.needsSync ? ' pp-sync-warn' : ''}`}>
                  <span />
                  <div>
                    <strong>{status === null ? 'Checking customer sync' : status.needsSync ? 'Customer sync pending' : 'Customer sync healthy'}</strong>
                    <small>
                      {status === null
                        ? 'Reading the latest agent run…'
                        : `${status.syncedCustomers.toLocaleString()} customers · ${status.linkedActivities.toLocaleString()} linked signals`}
                    </small>
                  </div>
                </div>
              </header>

              <nav className="pp-tabs" aria-label="People sections">
                {sections.map((section) => (
                  <button
                    type="button"
                    key={section.key}
                    className={role === section.key ? 'is-active' : ''}
                    onClick={() => setRole(section.key)}
                  >
                    <strong>{section.label}</strong>
                    <span>{section.key === role && !loading ? `${count.toLocaleString()} people` : section.detail}</span>
                  </button>
                ))}
              </nav>

              {error !== null ? (
                <div className="pp-state pp-state-error" role="alert">
                  <strong>Couldn’t load people</strong>
                  <p>{error}</p>
                  <button type="button" onClick={() => void load(role)}>Try again</button>
                </div>
              ) : loading ? (
                <div className="pp-state" role="status">Loading {role}s…</div>
              ) : people.length === 0 ? (
                <div className="pp-state pp-empty">
                  <strong>No {role}s synced</strong>
                  <p>{role === 'customer' ? 'The customer source is currently empty.' : `The ${role} sync will be added as its own agent.`}</p>
                </div>
              ) : (
                <section className="pp-directory" aria-label={`${role} directory`}>
                  <div className="pp-columns" aria-hidden="true">
                    <span>Person</span><span>Contact</span><span>Signals</span><span>Source</span>
                  </div>
                  {people.map((person) => (
                    <article className="pp-row" key={person.id}>
                      <div className="pp-person">
                        <span className="pp-avatar">{initials(person.displayName)}</span>
                        <div>
                          <strong>{person.displayName}</strong>
                          <span className="pp-role">{person.roles.join(' · ')}</span>
                        </div>
                      </div>
                      <div className="pp-contact">
                        <span>{person.primaryEmail ?? 'No email'}</span>
                        <small>{person.primaryPhone ?? 'No phone'}</small>
                      </div>
                      <div className="pp-signals">
                        <span>{person.linkedSignalCount.toLocaleString()}</span>
                        <small>{relativeTime(person.lastSignalAt)}</small>
                      </div>
                      <div className="pp-source">
                        <span>Ottawa Painters Admin</span>
                        <small>Synced {relativeTime(person.lastSyncedAt)}</small>
                      </div>
                    </article>
                  ))}

                  {nextOffset !== null ? (
                    <button
                      type="button"
                      className="pp-more"
                      disabled={loadingMore}
                      onClick={() => void load(role, nextOffset, true)}
                    >
                      {loadingMore ? 'Loading…' : `Show ${Math.min(PAGE_SIZE, count - people.length)} more`}
                    </button>
                  ) : (
                    <p className="pp-end">Showing all {count.toLocaleString()} {role}s</p>
                  )}
                </section>
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
