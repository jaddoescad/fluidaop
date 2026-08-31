import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SideNav } from '../components/AppChrome';
import { apiJson as api } from '../lib/api';
import '../variants/flow.css';
import '../variants/zen.css';
import './people.css';

const PAGE_SIZE = 30;

interface ContactCursor { createdAt: string; id: string }
interface ActivityCursor { occurredAt: string; id: number }
interface RoleDefinition { key: string; name: string; description: string }
interface ContactRow {
  id: string; displayName: string; primaryEmail: string | null; primaryPhone: string | null;
  status: 'active' | 'archived'; entityType: 'person' | 'business'; roles: string[];
  linkedSignalCount: number; lastSignalAt: string | null; dealCount: number; activeDealCount: number;
  createdAt: string; updatedAt: string;
}
interface ContactsPayload { contacts: ContactRow[]; count: number; nextCursor: ContactCursor | null }
interface ContactDetailPayload {
  contact: ContactRow;
  roles: Array<{ role_key: string; source_system: string; last_seen_at: string; sourceCount: number }>;
  identifiers: Array<{
    id: string; kind: 'email' | 'phone' | 'provider'; value: string; displayName: string | null;
    classification: string; confidence: number; primary: boolean;
    sourceCount: number;
    source: { system: string; recordType: string; recordId: string };
    firstSeenAt: string; lastSeenAt: string;
  }>;
  sources: Array<{ source_system: string; source_record_type: string; source_record_id: string; last_synced_at: string }>;
  deals: {
    count: number;
    activeCount: number;
    items: Array<{
      id: string; name: string; stage: string; status: string; amountCents: number;
      source: string | null; salesperson: string | null; active: boolean;
      stageEnteredAt: string | null; firstSeenAt: string; lastSeenAt: string;
    }>;
  };
}
interface ContactActivity {
  id: number; source: 'gmail' | 'quo'; event_type: string; direction: 'inbound' | 'outbound';
  subject: string; preview: string; occurred_at: string; actor_email: string | null; actor_phone: string | null;
  classifications?: Array<{ label_kind: 'topic' | 'urgency'; label: { key: string; name: string; color: string } | null }>;
}
interface ContactActivitiesPayload { signals: ContactActivity[]; nextCursor: ActivityCursor | null }

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return `${words[0]?.[0] ?? ''}${words.length > 1 ? words[words.length - 1]?.[0] ?? '' : ''}`.toUpperCase();
}

function relativeTime(value: string | null): string {
  if (value === null) return 'No activity yet';
  const time = Date.parse(value);
  if (Number.isNaN(time)) return 'Unknown time';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function cursorQuery(cursor: ContactCursor | ActivityCursor | null): string {
  if (cursor === null) return '';
  const params = new URLSearchParams();
  params.set('cursorAt', 'createdAt' in cursor ? cursor.createdAt : cursor.occurredAt);
  params.set('cursorId', String(cursor.id));
  return `&${params.toString()}`;
}

const sourceLabel = (source: 'gmail' | 'quo') => source === 'gmail' ? 'Gmail' : 'Quo';
const money = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'CAD',
  maximumFractionDigits: 2,
});

function ContactDetail({ contactId, onClose }: { contactId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<ContactDetailPayload | null>(null);
  const [activities, setActivities] = useState<ContactActivity[]>([]);
  const [nextCursor, setNextCursor] = useState<ActivityCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const loadActivities = useCallback(async (cursor: ActivityCursor | null, append: boolean) => {
    if (append) setLoadingMore(true);
    const payload = await api<ContactActivitiesPayload>(`/api/contacts/${contactId}/activities?limit=${PAGE_SIZE}${cursorQuery(cursor)}`);
    setActivities((current) => append ? [...current, ...payload.signals] : payload.signals);
    setNextCursor(payload.nextCursor);
    if (append) setLoadingMore(false);
  }, [contactId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    Promise.all([
      api<ContactDetailPayload>(`/api/contacts/${contactId}`),
      api<ContactActivitiesPayload>(`/api/contacts/${contactId}/activities?limit=${PAGE_SIZE}`),
    ]).then(([nextDetail, nextActivities]) => {
      if (cancelled) return;
      setDetail(nextDetail); setActivities(nextActivities.signals); setNextCursor(nextActivities.nextCursor);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [contactId]);

  return (
    <aside className="pp-detail" role="dialog" aria-modal="true" aria-label="Contact details">
      <button type="button" className="pp-detail-close" onClick={onClose} aria-label="Close Contact details" autoFocus>×</button>
      {loading ? <div className="pp-state">Loading Contact…</div> : error ? (
        <div className="pp-state pp-state-error"><strong>Couldn’t load Contact</strong><p>{error}</p></div>
      ) : detail ? <>
        <header className="pp-detail-head">
          <span className="pp-avatar pp-avatar-large">{initials(detail.contact.displayName)}</span>
          <div><span className="pp-kicker">{detail.contact.entityType}</span><h2>{detail.contact.displayName}</h2><p>{detail.contact.primaryEmail ?? detail.contact.primaryPhone ?? 'No primary identifier'}</p></div>
        </header>
        <section className="pp-detail-section"><h3>Roles</h3><div className="pp-pills">
          {detail.roles.length > 0 ? [...new Set(detail.roles.map((role) => role.role_key))].map((role) => <span key={role}>{role}</span>) : <small>No role assigned</small>}
        </div></section>
        <section className="pp-detail-section"><h3>Identifiers</h3><div className="pp-identifiers">
          {detail.identifiers.map((identifier) => <div key={identifier.id}><span>{identifier.kind}</span><strong>{identifier.value}</strong><small>{identifier.sourceCount} evidence source{identifier.sourceCount === 1 ? '' : 's'} · exact match</small></div>)}
        </div></section>
        <section className="pp-detail-section pp-deals"><h3>Deals <span>{detail.deals.count}</span></h3>
          {detail.deals.items.length === 0 ? <p className="pp-muted">No DripJobs deals linked to this Contact.</p> : detail.deals.items.map((deal) => <article key={deal.id}>
            <span className={`pp-deal-state${deal.active ? ' is-active' : ''}`}>{deal.active ? 'Active' : 'Archived'}</span>
            <div><strong>{deal.name}</strong><p>{deal.stage} · {deal.source ?? 'Unknown source'}</p><small>{deal.salesperson ?? 'Unassigned'} · last seen {relativeTime(deal.lastSeenAt)}</small></div>
            {deal.amountCents > 0 ? <b>{money.format(deal.amountCents / 100)}</b> : null}
          </article>)}
        </section>
        <section className="pp-detail-section pp-history"><h3>Signal history <span>{activities.length}</span></h3>
          {activities.length === 0 ? <p className="pp-muted">No linked Gmail or Quo Signals.</p> : activities.map((signal) => {
            const topic = signal.classifications?.find((classification) => classification.label_kind === 'topic')?.label;
            return <article key={signal.id}>
              <div className={`pp-source-mark is-${signal.source}`}>{signal.source === 'gmail' ? 'M' : 'Q'}</div>
              <div><strong>{signal.subject}</strong><p>{signal.preview || 'No preview'}</p><small>{sourceLabel(signal.source)} · {signal.direction} · {relativeTime(signal.occurred_at)}</small></div>
              {topic ? <span className="pp-topic" style={{ borderColor: topic.color }}>{topic.name}</span> : null}
            </article>;
          })}
          {nextCursor ? <button type="button" className="pp-more" disabled={loadingMore} onClick={() => void loadActivities(nextCursor, true).catch((cause: unknown) => { setLoadingMore(false); setError(cause instanceof Error ? cause.message : String(cause)); })}>{loadingMore ? 'Loading…' : 'Load older Signals'}</button> : null}
        </section>
      </> : null}
    </aside>
  );
}

export function PeoplePage({ onNavigate, header, view = 'contacts' }: {
  onNavigate: (label: string) => void;
  header: ReactNode;
  /** Which population this page shows. Employees are separated from customer-facing
      contacts because they are a different kind of record, not a filter of one. */
  view?: 'contacts' | 'employees';
}) {
  const employees = view === 'employees';
  const role = employees ? 'employee' : 'lead';
  const navLabel = employees ? 'Employees' : 'Contacts';
  const [roles, setRoles] = useState<RoleDefinition[]>([]);
  const [search, setSearch] = useState('');
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [contactCount, setContactCount] = useState(0);
  const [contactCursor, setContactCursor] = useState<ContactCursor | null>(null);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const requestRevision = useRef(0);
  const contactRequest = useRef<AbortController | null>(null);
  const roleName = useMemo(() => new Map(roles.map((item) => [item.key, item.name])), [roles]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const loadContacts = useCallback(async (cursor: ContactCursor | null, append: boolean, selectedRole = role) => {
    const revision = append ? requestRevision.current : ++requestRevision.current;
    if (!append) contactRequest.current?.abort();
    const controller = new AbortController();
    contactRequest.current = controller;
    if (append) setLoadingMore(true); else setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (selectedRole) params.set('role', selectedRole);
      if (debouncedSearch) params.set('q', debouncedSearch);
      if (cursor) { params.set('cursorAt', cursor.createdAt); params.set('cursorId', cursor.id); }
      const payload = await api<ContactsPayload>(`/api/contacts?${params.toString()}`, { signal: controller.signal });
      if (revision !== requestRevision.current) return;
      setContacts((current) => append ? [...current, ...payload.contacts] : payload.contacts);
      setContactCount(payload.count); setContactCursor(payload.nextCursor);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError') && revision === requestRevision.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (revision === requestRevision.current) {
        if (append) setLoadingMore(false); else setLoading(false);
      }
      if (contactRequest.current === controller) contactRequest.current = null;
    }
  }, [debouncedSearch, role]);


  useEffect(() => {
    void api<{ roles: RoleDefinition[] }>('/api/contacts/roles')
      .then((payload) => setRoles(payload.roles))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  useEffect(() => { void loadContacts(null, false, role); }, [loadContacts, role]);


  return <div className="v v-flow v-zen pp-root"><div className="fl-shell">
    <SideNav active={navLabel} onNav={onNavigate} />
    <div className="fl-frame">{header}<main className="pp-main"><div className="pp-inner">
      <header className="pp-head"><div><h1>{navLabel}</h1><p>{employees
        ? 'People who work here, and the calls and messages they appear in.'
        : 'People and businesses connected across Gmail, Quo messages, and calls.'}</p></div><div className="pp-counts"><span><strong>{contactCount.toLocaleString()}</strong> {navLabel}</span></div></header>
      <div className="pp-toolbar"><label className="pp-search"><span aria-hidden="true">⌕</span><input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setSelectedContactId(null); }} placeholder={`Search ${navLabel}`} aria-label={`Search ${navLabel}`} /></label></div>
      {error ? <div className="pp-state pp-state-error" role="alert"><strong>Couldn’t complete that request</strong><p>{error}</p><button type="button" onClick={() => void loadContacts(null, false)}>Try again</button></div>
        : loading ? <div className="pp-state" role="status">Loading contacts…</div>
        : contacts.length === 0 ? <div className="pp-state"><strong>No {navLabel.toLowerCase()} yet</strong><p>Unmatched identities stay hidden until they are safely resolved.</p></div> : <section className="pp-directory" aria-label="Contact directory">
          <div className="pp-columns" aria-hidden="true"><span>Contact</span><span>Identifiers</span><span>Role</span><span>Deals</span><span>Signals</span></div>
          {contacts.map((contact) => <button type="button" className="pp-row" key={contact.id} onClick={() => setSelectedContactId(contact.id)}>
            <span className="pp-person"><span className="pp-avatar">{initials(contact.displayName)}</span><span><strong>{contact.displayName}</strong><small>{contact.entityType}</small></span></span>
            <span className="pp-contact"><span>{contact.primaryEmail ?? contact.primaryPhone ?? 'No primary identifier'}</span><small>{contact.primaryEmail && contact.primaryPhone ? contact.primaryPhone : ''}</small></span>
            <span className="pp-pills">{contact.roles.length > 0 ? contact.roles.map((item) => <span key={item}>{roleName.get(item) ?? item}</span>) : <small>No role</small>}</span>
            <span className="pp-signals"><span>{contact.dealCount.toLocaleString()}</span><small>{contact.activeDealCount} active</small></span>
            <span className="pp-signals"><span>{contact.linkedSignalCount.toLocaleString()}</span><small>{relativeTime(contact.lastSignalAt)}</small></span>
          </button>)}
          {contactCursor ? <button type="button" className="pp-more" disabled={loadingMore} onClick={() => void loadContacts(contactCursor, true)}>{loadingMore ? 'Loading…' : `Load more ${navLabel.toLowerCase()}`}</button> : <p className="pp-end">Showing all {contactCount.toLocaleString()} {navLabel.toLowerCase()}</p>}
        </section>}
    </div></main>{selectedContactId ? <ContactDetail contactId={selectedContactId} onClose={() => setSelectedContactId(null)} /> : null}</div>
  </div></div>;
}
